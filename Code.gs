/**
 * IT Desk — Helpdesk & Asset Management
 * Google Apps Script backend. Google Sheets is the database.
 *
 * SECURITY MODEL (read before editing)
 * - The web app runs as the owner, so the browser is never trusted. Every function the
 *   browser can call starts with requireUser_(token) and checks the role itself.
 * - Any global function whose name does NOT end in "_" can be called from the browser
 *   via google.script.run. The three owner-only tools (createInitialAdmin, promoteToAdmin,
 *   setUserAccess) therefore take no arguments from the caller: they read their input
 *   from Script Properties, which only the project owner can edit, and clear it afterwards.
 */

const CONFIG = {
  APP_NAME: 'IT Helpdesk & Asset Management',
  SESSION_SECONDS: 21600,      // 6 hours (CacheService maximum)
  MAX_LOGIN_FAILS: 5,
  LOCKOUT_SECONDS: 900,        // 15 minutes
  SHEETS: {
    USERS: 'Users',
    DEPARTMENTS: 'Departments',
    ASSETS: 'Assets',
    TICKETS: 'Tickets',
    TICKET_UPDATES: 'TicketUpdates'
  },
  STATUSES: ['New', 'Acknowledged', 'In Progress', 'Waiting for Employee', 'Resolved', 'Closed'],
  PRIORITIES: ['Low', 'Medium', 'High', 'Urgent'],
  CONDITIONS: ['New', 'Good', 'Fair', 'Faulty', 'Retired'],
  CATEGORIES: ['Hardware', 'Software', 'Network / Internet', 'Email / Account', 'Printer / Peripheral', 'Access Request', 'Other']
};

// Column layout of every tab. "dates" columns hold real dates; every other column is forced to
// plain text so Sheets cannot turn "2025-03-04" into a Date, "00123" into 123, or "=cmd" into a formula.
const SCHEMA = {
  Users:         {headers: ['userId','fullName','email','department','passwordSalt','passwordHash','role','active','createdAt'], dates: ['createdAt']},
  Departments:   {headers: ['departmentId','departmentName'], dates: []},
  Assets:        {headers: ['assetId','assetTag','assetType','brandModel','serialNumber','assignedToEmail','department','condition','purchaseDate','notes','createdAt'], dates: ['createdAt']},
  Tickets:       {headers: ['ticketId','createdAt','employeeName','employeeEmail','department','assetTag','category','title','description','priority','status','assignedTo','resolution','resolvedAt','updatedAt'], dates: ['createdAt','resolvedAt','updatedAt']},
  TicketUpdates: {headers: ['updateId','ticketId','authorEmail','authorRole','message','status','createdAt'], dates: ['createdAt']}
};

const ASSET_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._\/-]{0,59}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* =====================================================================
 * OWNER-ONLY SETUP TOOLS (run from the Apps Script editor)
 * ===================================================================== */

/** Run once. Creates the tabs and headers. Safe to run again. */
function setupDatabase() {
  const ss = getDatabase_();
  Object.keys(SCHEMA).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(SCHEMA[name].headers);
      if (typeof sh.setFrozenRows === 'function') sh.setFrozenRows(1);
    }
  });
  const dept = ss.getSheetByName(CONFIG.SHEETS.DEPARTMENTS);
  if (dept.getLastRow() === 1) {
    ['Administration','Accounts','Human Resources','Sales','Operations','IT','Customer Service','Other']
      .forEach((name, i) => appendObject_(CONFIG.SHEETS.DEPARTMENTS, {departmentId: 'DEP-' + (i + 1), departmentName: name}));
  }
  return 'Database is ready.';
}

/**
 * Creates an IT administrator. Nothing is typed into the source code.
 * First set these in Project Settings -> Script Properties:
 *   ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD (12+ characters)
 * then run this function. ADMIN_PASSWORD is deleted automatically afterwards.
 * Run it again with different values to add more IT staff.
 */
function createInitialAdmin() {
  const props = PropertiesService.getScriptProperties();
  const email = String(props.getProperty('ADMIN_EMAIL') || '').trim().toLowerCase();
  const fullName = clean_(props.getProperty('ADMIN_NAME') || 'IT Administrator', 100);
  const password = String(props.getProperty('ADMIN_PASSWORD') || '');
  props.deleteProperty('ADMIN_PASSWORD'); // never leave a password lying around, even if validation fails below
  if (!email || !password) throw new Error('Set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD in Project Settings > Script Properties, then run again.');
  if (!EMAIL_PATTERN.test(email)) throw new Error('ADMIN_EMAIL is not a valid email address.');
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters. Set it again and re-run.');
  return withLock_(() => {
    if (findRowByValue_(CONFIG.SHEETS.USERS, 'email', email)) throw new Error('An account with this email already exists. Use promoteToAdmin() instead.');
    const salt = Utilities.getUuid();
    appendObject_(CONFIG.SHEETS.USERS, {
      userId: Utilities.getUuid(), fullName, email, department: 'IT',
      passwordSalt: salt, passwordHash: hashPassword_(password, salt),
      role: 'admin', active: 'TRUE', createdAt: new Date()
    });
    return 'Administrator created: ' + email;
  });
}

/**
 * Turns an existing employee account into IT Support.
 * Set PROMOTE_EMAIL in Script Properties, then run. The property is cleared afterwards.
 */
function promoteToAdmin() {
  const props = PropertiesService.getScriptProperties();
  const email = String(props.getProperty('PROMOTE_EMAIL') || '').trim().toLowerCase();
  props.deleteProperty('PROMOTE_EMAIL');
  if (!email) throw new Error('Set PROMOTE_EMAIL in Script Properties, then run again.');
  return withLock_(() => {
    const u = findRowByValue_(CONFIG.SHEETS.USERS, 'email', email);
    if (!u) throw new Error('No account found for ' + email + '. They must register first.');
    setFields_(CONFIG.SHEETS.USERS, u.__row, {role: 'admin', active: 'TRUE'});
    return email + ' is now IT Support.';
  });
}

/**
 * Changes or disables an account. Set in Script Properties, then run:
 *   USER_EMAIL = the account
 *   USER_ACCESS = employee | admin | disabled | enabled
 * Both properties are cleared afterwards. The last active admin cannot be removed.
 */
function setUserAccess() {
  const props = PropertiesService.getScriptProperties();
  const email = String(props.getProperty('USER_EMAIL') || '').trim().toLowerCase();
  const access = String(props.getProperty('USER_ACCESS') || '').trim().toLowerCase();
  props.deleteProperty('USER_EMAIL'); props.deleteProperty('USER_ACCESS');
  if (!email || ['employee','admin','disabled','enabled'].indexOf(access) < 0) {
    throw new Error('Set USER_EMAIL and USER_ACCESS (employee, admin, disabled or enabled) in Script Properties, then run again.');
  }
  return withLock_(() => {
    const u = findRowByValue_(CONFIG.SHEETS.USERS, 'email', email);
    if (!u) throw new Error('No account found for ' + email);
    const changes = {};
    if (access === 'admin' || access === 'employee') changes.role = access;
    if (access === 'disabled') changes.active = 'FALSE';
    if (access === 'enabled') changes.active = 'TRUE';
    const losesAdmin = isAdmin_(u) && isActive_(u) && (changes.role === 'employee' || changes.active === 'FALSE');
    if (losesAdmin && activeAdmins_().length <= 1) throw new Error('You cannot remove the last active IT administrator.');
    setFields_(CONFIG.SHEETS.USERS, u.__row, changes);
    // End any open session immediately by making sessions re-check the sheet (done in requireUser_).
    return email + ' set to ' + access + '.';
  });
}

/* =====================================================================
 * AUTHENTICATION
 * ===================================================================== */

function registerUser(payload) {
  payload = payload || {};
  const fullName = clean_(payload.fullName, 100);
  const email = clean_(payload.email, 160).toLowerCase();
  const department = clean_(payload.department, 80);
  const password = String(payload.password || '');
  if (!fullName || !email || !department || !EMAIL_PATTERN.test(email)) {
    throw new Error('Please provide your name, a valid email and department.');
  }
  if (password.length < 10) throw new Error('Use a password with at least 10 characters.');
  if (password.length > 200) throw new Error('That password is too long.');
  const departments = readObjects_(CONFIG.SHEETS.DEPARTMENTS).map(x => String(x.departmentName));
  if (departments.indexOf(department) < 0) throw new Error('Please choose a department from the list.');
  withLock_(() => {
    if (findRowByValue_(CONFIG.SHEETS.USERS, 'email', email)) throw new Error('An account with this email already exists.');
    const salt = Utilities.getUuid();
    appendObject_(CONFIG.SHEETS.USERS, {
      userId: Utilities.getUuid(), fullName, email, department,
      passwordSalt: salt, passwordHash: hashPassword_(password, salt),
      role: 'employee', active: 'TRUE', createdAt: new Date()   // role is never taken from the browser
    });
  });
  return login({email, password});
}

function login(payload) {
  const email = clean_(payload && payload.email, 160).toLowerCase();
  const password = String((payload && payload.password) || '');
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + email;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= CONFIG.MAX_LOGIN_FAILS) throw new Error('Too many failed sign-in attempts. Please wait 15 minutes and try again.');
  const user = email ? findRowByValue_(CONFIG.SHEETS.USERS, 'email', email) : null;
  if (!user || !isActive_(user) || hashPassword_(password, user.passwordSalt) !== String(user.passwordHash)) {
    cache.put(failKey, String(fails + 1), CONFIG.LOCKOUT_SECONDS);
    throw new Error('Email or password is incorrect.');
  }
  cache.remove(failKey);
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('session_' + token, JSON.stringify({email: String(user.email).toLowerCase()}), CONFIG.SESSION_SECONDS);
  return {token, user: publicUser_(user)};
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('session_' + token);
  return true;
}

function getPublicDepartments() {
  return readObjects_(CONFIG.SHEETS.DEPARTMENTS).map(x => String(x.departmentName));
}

/* =====================================================================
 * DATA FOR THE SCREENS
 * ===================================================================== */

function getInitialData(token) {
  const user = requireUser_(token);
  const admin = isAdmin_(user);
  const allTickets = readObjects_(CONFIG.SHEETS.TICKETS);
  const tickets = admin ? allTickets : allTickets.filter(t => lower_(t.employeeEmail) === user.email);

  // Open (unresolved) ticket count per asset tag, from the tickets this user is allowed to see.
  const openByTag = {};
  tickets.forEach(t => {
    const tag = upper_(t.assetTag);
    if (tag && t.status !== 'Resolved' && t.status !== 'Closed') openByTag[tag] = (openByTag[tag] || 0) + 1;
  });

  let assets, technicians = [];
  if (admin) {
    assets = readObjects_(CONFIG.SHEETS.ASSETS).map(a => publicAsset_(a, openByTag));
    technicians = activeAdmins_().map(a => ({name: s_(a.fullName), email: lower_(a.email)}));
  } else {
    // "My Equipment": an employee only ever receives assets assigned to their own email.
    assets = readObjects_(CONFIG.SHEETS.ASSETS)
      .filter(a => lower_(a.assignedToEmail) === user.email)
      .map(a => publicEquipment_(a, openByTag));
  }
  return {
    user: publicUser_(user),
    departments: readObjects_(CONFIG.SHEETS.DEPARTMENTS).map(x => String(x.departmentName)),
    categories: CONFIG.CATEGORIES,
    assets,
    technicians,
    tickets: tickets.map(publicTicket_),
    stats: buildStats_(tickets)
  };
}

/* =====================================================================
 * TICKETS
 * ===================================================================== */

function createTicket(token, payload) {
  const user = requireUser_(token);
  payload = payload || {};
  const title = clean_(payload.title, 140);
  const description = clean_(payload.description, 3000);
  const category = CONFIG.CATEGORIES.indexOf(payload.category) >= 0 ? payload.category : '';
  const priority = CONFIG.PRIORITIES.indexOf(payload.priority) >= 0 ? payload.priority : 'Medium';
  const assetTag = upper_(clean_(payload.assetTag, 60));
  if (!title || !description || !category) throw new Error('Complete the title, category and description.');
  if (assetTag && !ASSET_TAG_PATTERN.test(assetTag)) throw new Error('The asset tag may only contain letters, numbers, spaces and - . _ /');
  const now = new Date();
  return withLock_(() => {
    let ticketId;
    do {
      ticketId = 'IT-' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy') + '-' +
        Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
    } while (findRowByValue_(CONFIG.SHEETS.TICKETS, 'ticketId', ticketId));
    appendObject_(CONFIG.SHEETS.TICKETS, {
      ticketId, createdAt: now, employeeName: user.fullName, employeeEmail: user.email,
      department: user.department, assetTag, category, title, description, priority,
      status: 'New', assignedTo: '', resolution: '', resolvedAt: '', updatedAt: now
    });
    addUpdate_(ticketId, user, 'Complaint submitted.', 'New');
    return {ticketId};
  });
}

/** IT Support only: assign a technician, change status, record the resolution. */
function updateTicket(token, payload) {
  const user = requireUser_(token);
  if (!isAdmin_(user)) throw new Error('Only IT Support can update tickets.');
  payload = payload || {};
  return withLock_(() => {
    const ticket = findRowByValue_(CONFIG.SHEETS.TICKETS, 'ticketId', clean_(payload.ticketId, 80));
    if (!ticket) throw new Error('Ticket not found.');

    let status = ticket.status;
    if (payload.status !== undefined && payload.status !== '') {
      if (CONFIG.STATUSES.indexOf(payload.status) < 0) throw new Error('Unknown status.');
      status = payload.status;
    }
    let assignedTo = lower_(ticket.assignedTo);
    if (payload.assignedTo !== undefined) {
      assignedTo = clean_(payload.assignedTo, 160).toLowerCase();
      if (assignedTo && !activeAdmins_().some(a => lower_(a.email) === assignedTo)) {
        throw new Error('Choose a technician from the IT Support list.');
      }
    }
    const resolution = payload.resolution !== undefined ? clean_(payload.resolution, 3000) : s_(ticket.resolution);
    const finished = status === 'Resolved' || status === 'Closed';
    if (finished && !resolution) throw new Error('Record the resolution before marking the ticket ' + status + '.');

    const changes = [];
    if (status !== ticket.status) changes.push('Status changed from ' + ticket.status + ' to ' + status + '.');
    if (assignedTo !== lower_(ticket.assignedTo)) changes.push(assignedTo ? 'Assigned to ' + assignedTo + '.' : 'Technician unassigned.');
    if (resolution !== s_(ticket.resolution)) changes.push(resolution ? 'Resolution: ' + resolution : 'Resolution cleared.');
    const note = clean_(payload.message, 1500);
    if (!changes.length && !note) throw new Error('There are no changes to save.');

    const now = new Date();
    setFields_(CONFIG.SHEETS.TICKETS, ticket.__row, {
      status, assignedTo, resolution,
      resolvedAt: finished ? (ticket.resolvedAt || now) : '',   // re-opening a ticket clears the resolved time
      updatedAt: now
    });
    addUpdate_(ticket.ticketId, user, [note].concat(changes).filter(Boolean).join('\n'), status);
    return true;
  });
}

/** Employee (own tickets only) or IT Support adds a message to a ticket. */
function addEmployeeUpdate(token, payload) {
  const user = requireUser_(token);
  payload = payload || {};
  return withLock_(() => {
    const ticket = getAccessibleTicket_(user, payload.ticketId);
    const message = clean_(payload.message, 1500);
    if (!message) throw new Error('Enter an update message.');
    if (!isAdmin_(user) && ticket.status === 'Closed') throw new Error('This ticket is closed. Submit a new complaint if the problem returns.');
    let status = ticket.status;
    // An employee answering a question from IT puts the ticket back in the technician's queue.
    if (!isAdmin_(user) && status === 'Waiting for Employee') status = 'In Progress';
    if (status !== ticket.status) setFields_(CONFIG.SHEETS.TICKETS, ticket.__row, {status, updatedAt: new Date()});
    else setFields_(CONFIG.SHEETS.TICKETS, ticket.__row, {updatedAt: new Date()});
    addUpdate_(ticket.ticketId, user, message, status);
    return true;
  });
}

function getTicketUpdates(token, ticketId) {
  const user = requireUser_(token);
  const ticket = getAccessibleTicket_(user, ticketId);
  const names = {};
  readObjects_(CONFIG.SHEETS.USERS).forEach(u => { names[lower_(u.email)] = s_(u.fullName); });
  return readObjects_(CONFIG.SHEETS.TICKET_UPDATES)
    .filter(x => s_(x.ticketId) === s_(ticket.ticketId))
    .map(x => ({
      authorName: names[lower_(x.authorEmail)] || s_(x.authorEmail),
      authorRole: s_(x.authorRole) === 'admin' ? 'IT Support' : 'Employee',
      message: s_(x.message), status: s_(x.status),
      createdAt: formatDate_(x.createdAt), createdAtTs: ts_(x.createdAt)
    }))
    .sort((a, b) => a.createdAtTs - b.createdAtTs);
}

/* =====================================================================
 * ASSETS (IT Support only)
 * ===================================================================== */

function saveAsset(token, payload) {
  const user = requireUser_(token);
  if (!isAdmin_(user)) throw new Error('Only IT Support can manage assets.');
  payload = payload || {};
  const assetTag = upper_(clean_(payload.assetTag, 60));
  if (!assetTag) throw new Error('Asset tag is required.');
  if (!ASSET_TAG_PATTERN.test(assetTag)) throw new Error('The asset tag may only contain letters, numbers, spaces and - . _ /');
  const assignedToEmail = clean_(payload.assignedToEmail, 160).toLowerCase();
  if (assignedToEmail && !EMAIL_PATTERN.test(assignedToEmail)) throw new Error('The assigned employee email is not valid.');
  const purchaseDate = clean_(payload.purchaseDate, 30);
  if (purchaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw new Error('Use the date picker for the purchase date.');
  return withLock_(() => {
    const existing = findRowByValue_(CONFIG.SHEETS.ASSETS, 'assetTag', assetTag);
    const record = {
      assetId: existing ? existing.assetId : Utilities.getUuid(),
      assetTag,
      assetType: clean_(payload.assetType, 80),
      brandModel: clean_(payload.brandModel, 120),
      serialNumber: clean_(payload.serialNumber, 120),
      assignedToEmail,
      department: clean_(payload.department, 80),
      condition: CONFIG.CONDITIONS.indexOf(payload.condition) >= 0 ? payload.condition : 'Good',
      purchaseDate,
      notes: clean_(payload.notes, 1000),
      createdAt: existing ? existing.createdAt : new Date()
    };
    if (existing) updateObjectRow_(CONFIG.SHEETS.ASSETS, existing.__row, record);
    else appendObject_(CONFIG.SHEETS.ASSETS, record);
    return {created: !existing};
  });
}

/* =====================================================================
 * HELPERS
 * ===================================================================== */

let DB_ = null;
function getDatabase_() {
  if (DB_) return DB_;
  const id = PropertiesService.getScriptProperties().getProperty('DATABASE_ID');
  if (!id) throw new Error('Database not configured. Follow the README setup instructions.');
  DB_ = SpreadsheetApp.openById(id);
  return DB_;
}
function getSheet_(name) {
  if (!name) throw new Error('Internal error: no sheet name given.');
  const sh = getDatabase_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet: ' + name + '. Run setupDatabase().');
  return sh;
}
function getHeaders_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}
function readObjects_(name) {
  const sh = getSheet_(name), values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).map((r, i) => {
    const o = {__row: i + 2};
    headers.forEach((h, j) => o[h] = r[j]);
    return o;
  });
}
function findRowByValue_(sheetName, key, value) {
  const v = String(value).toLowerCase();
  return readObjects_(sheetName).find(o => String(o[key]).toLowerCase() === v) || null;
}
function formatsFor_(sheetName, headers) {
  const dates = (SCHEMA[sheetName] || {dates: []}).dates;
  return headers.map(h => dates.indexOf(h) >= 0 ? 'yyyy-mm-dd hh:mm:ss' : '@');
}
function appendObject_(sheetName, obj) {
  const sh = getSheet_(sheetName), headers = getHeaders_(sh);
  const row = sh.getLastRow() + 1;
  const range = sh.getRange(row, 1, 1, headers.length);
  range.setNumberFormats([formatsFor_(sheetName, headers)]);  // format first so nothing is auto-converted
  range.setValues([headers.map(h => obj[h] === undefined ? '' : obj[h])]);
}
function updateObjectRow_(sheetName, row, obj) {
  const sh = getSheet_(sheetName), headers = getHeaders_(sh);
  const range = sh.getRange(row, 1, 1, headers.length);
  range.setNumberFormats([formatsFor_(sheetName, headers)]);
  range.setValues([headers.map(h => obj[h] === undefined ? '' : obj[h])]);
}
/** Changes only the named columns of one row, leaving everything else untouched. */
function setFields_(sheetName, row, fields) {
  const sh = getSheet_(sheetName), headers = getHeaders_(sh);
  const range = sh.getRange(row, 1, 1, headers.length);
  const current = range.getValues()[0];
  Object.keys(fields).forEach(k => {
    const i = headers.indexOf(k);
    if (i < 0) throw new Error('Unknown column ' + k + ' in ' + sheetName);
    current[i] = fields[k];
  });
  range.setNumberFormats([formatsFor_(sheetName, headers)]);
  range.setValues([current]);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + String(password), Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

/**
 * Validates the session AND re-reads the account from the sheet on every call, so a role
 * change or a disabled account takes effect immediately instead of after the session expires.
 */
function requireUser_(token) {
  const raw = token && CacheService.getScriptCache().get('session_' + token);
  if (!raw) throw new Error('Your session has expired. Please sign in again.');
  const session = JSON.parse(raw);
  const u = findRowByValue_(CONFIG.SHEETS.USERS, 'email', session.email);
  if (!u || !isActive_(u)) {
    CacheService.getScriptCache().remove('session_' + token);
    throw new Error('Your account is not active. Contact IT Support.');
  }
  return {
    email: lower_(u.email), fullName: s_(u.fullName), department: s_(u.department),
    role: isAdmin_(u) ? 'admin' : 'employee'
  };
}
function isAdmin_(u) { return String(u.role).trim().toLowerCase() === 'admin'; }
function isActive_(u) { return String(u.active).trim().toUpperCase() === 'TRUE'; }
function activeAdmins_() {
  return readObjects_(CONFIG.SHEETS.USERS).filter(u => isAdmin_(u) && isActive_(u));
}
/** Returns the ticket only if this user is IT Support or the employee who raised it. */
function getAccessibleTicket_(user, ticketId) {
  const ticket = findRowByValue_(CONFIG.SHEETS.TICKETS, 'ticketId', clean_(ticketId, 80));
  if (!ticket) throw new Error('Ticket not found.');
  if (!isAdmin_(user) && lower_(ticket.employeeEmail) !== user.email) throw new Error('You cannot access this ticket.');
  return ticket;
}
function addUpdate_(ticketId, user, message, status) {
  appendObject_(CONFIG.SHEETS.TICKET_UPDATES, {
    updateId: Utilities.getUuid(), ticketId, authorEmail: user.email,
    authorRole: user.role, message, status, createdAt: new Date()
  });
}

// Shapes sent to the browser. Everything is converted to plain strings/numbers here because
// google.script.run silently fails if a Date object is returned.
function publicUser_(u) {
  return {fullName: s_(u.fullName), email: lower_(u.email), department: s_(u.department), role: isAdmin_(u) ? 'admin' : 'employee'};
}
function publicTicket_(t) {
  return {
    ticketId: s_(t.ticketId), createdAt: formatDate_(t.createdAt), createdAtTs: ts_(t.createdAt),
    employeeName: s_(t.employeeName), employeeEmail: s_(t.employeeEmail), department: s_(t.department),
    assetTag: s_(t.assetTag), category: s_(t.category), title: s_(t.title), description: s_(t.description),
    priority: s_(t.priority), status: s_(t.status), assignedTo: lower_(t.assignedTo), resolution: s_(t.resolution),
    resolvedAt: formatDate_(t.resolvedAt), updatedAt: formatDate_(t.updatedAt), updatedAtTs: ts_(t.updatedAt)
  };
}
function publicAsset_(a, openByTag) {
  return {
    assetTag: s_(a.assetTag), assetType: s_(a.assetType), brandModel: s_(a.brandModel),
    serialNumber: s_(a.serialNumber), assignedToEmail: lower_(a.assignedToEmail),
    department: s_(a.department), condition: s_(a.condition), purchaseDate: dateOnly_(a.purchaseDate),
    notes: s_(a.notes), openTickets: (openByTag || {})[upper_(a.assetTag)] || 0
  };
}
/** What an employee may see about their own equipment (no internal notes). */
function publicEquipment_(a, openByTag) {
  return {
    assetTag: s_(a.assetTag), assetType: s_(a.assetType), brandModel: s_(a.brandModel),
    serialNumber: s_(a.serialNumber), condition: s_(a.condition), purchaseDate: dateOnly_(a.purchaseDate),
    openTickets: (openByTag || {})[upper_(a.assetTag)] || 0
  };
}
function buildStats_(tickets) {
  return {
    total: tickets.length,
    newCount: tickets.filter(t => t.status === 'New').length,
    inProgress: tickets.filter(t => t.status === 'In Progress').length,
    resolved: tickets.filter(t => t.status === 'Resolved' || t.status === 'Closed').length,
    urgent: tickets.filter(t => t.priority === 'Urgent' || t.priority === 'High').length
  };
}
function clean_(value, max) {
  return String(value == null ? '' : value).trim().replace(/[<>]/g, '').slice(0, max);
}
function s_(v) { return v instanceof Date ? formatDate_(v) : String(v == null ? '' : v); }
function lower_(v) { return s_(v).trim().toLowerCase(); }
function upper_(v) { return s_(v).trim().toUpperCase(); }
function ts_(v) {
  if (!v) return 0;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
function formatDate_(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? String(value) : Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd MMM yyyy, HH:mm');
}
function dateOnly_(value) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(value);
}
