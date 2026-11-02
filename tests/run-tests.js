/**
 * Backend tests: runs the real Code.gs inside an Apps Script emulator.
 * Usage: node run-tests.js [path/to/Code.gs]
 */
const fs = require('fs');
const path = require('path');
const { makeEnv } = require('./gas-mock');

const codePath = process.argv[2] || path.join(__dirname, '..', 'it-helpdesk-asset-management', 'Code.gs');
const src = fs.readFileSync(codePath, 'utf8');

let pass = 0, fail = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + '\n         ' + e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'not equal') + ': got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
async function rejects(p, re, m) {
  try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error((m || 'wrong error') + ': ' + e.message); return; }
  throw new Error((m || 'expected an error') + ' but the call succeeded');
}

function freshEnv() {
  const env = makeEnv();
  env.props.DATABASE_ID = 'TEST_DB';
  env.load(src);
  return env;
}
async function bootstrap() {
  const env = freshEnv();
  await env.run('setupDatabase');
  env.props.ADMIN_EMAIL = 'IT@Company.com'; env.props.ADMIN_NAME = 'Tunde IT'; env.props.ADMIN_PASSWORD = 'A-strong-admin-pass-1';
  await env.run('createInitialAdmin');
  const admin = await env.run('login', { email: 'it@company.com', password: 'A-strong-admin-pass-1' });
  const reg = async (name, email, dept = 'Sales') => env.run('registerUser', { fullName: name, email, department: dept, password: 'employee-pass-123' });
  const ada = await reg('Ada Obi', 'ada@company.com');
  const bayo = await reg('Bayo Ade', 'bayo@company.com', 'Accounts');
  return { env, admin, ada, bayo, reg };
}

(async () => {
  console.log('\nSetup & accounts');
  await test('setupDatabase creates all 5 tabs with headers and seeds departments', async () => {
    const env = freshEnv(); await env.run('setupDatabase');
    ['Users','Departments','Assets','Tickets','TicketUpdates'].forEach(n => assert(env.sheets[n] && env.sheets[n].rows.length >= 1, 'missing ' + n));
    eq(env.sheets.Departments.rows.length, 9);
    await env.run('setupDatabase'); eq(env.sheets.Departments.rows.length, 9, 'setup must be idempotent');
  });
  await test('createInitialAdmin reads Script Properties and wipes the password afterwards', async () => {
    const { env } = await bootstrap();
    assert(!('ADMIN_PASSWORD' in env.props), 'password still stored in properties');
    assert(!JSON.stringify(env.sheets.Users.rows).includes('A-strong-admin-pass-1'), 'plaintext password in sheet');
  });
  await test('createInitialAdmin refuses weak password and still wipes it', async () => {
    const env = freshEnv(); await env.run('setupDatabase');
    env.props.ADMIN_EMAIL = 'x@y.com'; env.props.ADMIN_PASSWORD = 'short';
    await rejects(env.run('createInitialAdmin'), /at least 12/);
    assert(!('ADMIN_PASSWORD' in env.props));
  });
  await test('createInitialAdmin with nothing configured does nothing (safe if a visitor triggers it)', async () => {
    const { env } = await bootstrap(); const before = env.sheets.Users.rows.length;
    await rejects(env.run('createInitialAdmin'), /Set ADMIN_EMAIL/);
    eq(env.sheets.Users.rows.length, before);
  });
  await test('register: validation, duplicate email (case-insensitive), role forced to employee', async () => {
    const { env, ada } = await bootstrap();
    eq(ada.user.role, 'employee');
    await rejects(env.run('registerUser', { fullName: 'X', email: 'ADA@company.com', department: 'Sales', password: 'employee-pass-123' }), /already exists/);
    await rejects(env.run('registerUser', { fullName: 'X', email: 'bad', department: 'Sales', password: 'employee-pass-123' }), /valid email/);
    await rejects(env.run('registerUser', { fullName: 'X', email: 'x@y.com', department: 'Sales', password: 'short' }), /10 characters/);
    await rejects(env.run('registerUser', { fullName: 'X', email: 'x@y.com', department: 'Narnia', password: 'employee-pass-123' }), /department/);
    const sneaky = await env.run('registerUser', { fullName: 'Eve', email: 'eve@y.com', department: 'Sales', password: 'employee-pass-123', role: 'admin' });
    eq(sneaky.user.role, 'employee', 'role in payload must be ignored');
  });
  await test('login: wrong password rejected; same message for unknown email; lockout after 5 failures', async () => {
    const { env } = await bootstrap();
    await rejects(env.run('login', { email: 'ada@company.com', password: 'nope' }), /incorrect/);
    await rejects(env.run('login', { email: 'ghost@company.com', password: 'nope' }), /incorrect/);
    for (let i = 0; i < 4; i++) await rejects(env.run('login', { email: 'ada@company.com', password: 'nope' }), /incorrect/);
    await rejects(env.run('login', { email: 'ada@company.com', password: 'employee-pass-123' }), /Too many/, 'correct password must be refused while locked');
  });
  await test('user returned to the browser has no userId / hash / salt', async () => {
    const { env, ada } = await bootstrap();
    const d = await env.run('getInitialData', ada.token);
    eq(Object.keys(d.user).sort(), ['department','email','fullName','role']);
    assert(!JSON.stringify(d).match(/passwordHash|passwordSalt|userId/), 'secret field leaked');
  });
  await test('logout invalidates the token', async () => {
    const { env, ada } = await bootstrap();
    await env.run('logout', ada.token);
    await rejects(env.run('getInitialData', ada.token), /expired/);
  });

  console.log('\nPermissions');
  await test('every call rejects a missing / forged token', async () => {
    const { env } = await bootstrap();
    for (const [fn, args] of [['getInitialData', []], ['createTicket', [{ title: 'a', description: 'b', category: 'Other' }]], ['updateTicket', [{ ticketId: 'x' }]],
      ['addEmployeeUpdate', [{ ticketId: 'x', message: 'm' }]], ['getTicketUpdates', ['x']], ['saveAsset', [{ assetTag: 'A1' }]]]) {
      await rejects(env.run(fn, 'forged-token', ...args), /expired/, fn + ' accepted a forged token');
      await rejects(env.run(fn, undefined, ...args), /expired/, fn + ' accepted a missing token');
    }
  });
  await test('employee cannot update tickets, save assets, or escalate', async () => {
    const { env, ada } = await bootstrap();
    const { ticketId } = await env.run('createTicket', ada.token, { title: 'Screen flickers', description: 'It flickers', category: 'Hardware' });
    await rejects(env.run('updateTicket', ada.token, { ticketId, status: 'Resolved', resolution: 'self-resolved' }), /Only IT Support/);
    await rejects(env.run('saveAsset', ada.token, { assetTag: 'HACK-1', assignedToEmail: 'ada@company.com' }), /Only IT Support/);
    const d = await env.run('getInitialData', ada.token);
    eq(d.tickets[0].status, 'New'); eq(d.technicians, []); eq(d.assets, []);
  });
  await test('employee only sees their own tickets and cannot open/read/post to someone else\'s', async () => {
    const { env, ada, bayo } = await bootstrap();
    const t = await env.run('createTicket', ada.token, { title: 'Ada issue', description: 'secret details', category: 'Software' });
    eq((await env.run('getInitialData', bayo.token)).tickets.length, 0);
    await rejects(env.run('getTicketUpdates', bayo.token, t.ticketId), /cannot access/);
    await rejects(env.run('addEmployeeUpdate', bayo.token, { ticketId: t.ticketId, message: 'hi' }), /cannot access/);
  });
  await test('employee only receives equipment assigned to their own email, with no internal notes', async () => {
    const { env, admin, ada, bayo } = await bootstrap();
    await env.run('saveAsset', admin.token, { assetTag: 'lap-001', assetType: 'Laptop', brandModel: 'Dell 5420', serialNumber: '00123', assignedToEmail: 'ADA@company.com', condition: 'Good', purchaseDate: '2025-03-04', notes: 'INTERNAL: warranty dispute' });
    await env.run('saveAsset', admin.token, { assetTag: 'MON-002', assetType: 'Monitor', assignedToEmail: 'bayo@company.com' });
    const a = await env.run('getInitialData', ada.token);
    eq(a.assets.map(x => x.assetTag), ['LAP-001']);
    assert(!JSON.stringify(a.assets).includes('INTERNAL'), 'internal notes leaked to employee');
    eq(a.assets[0].serialNumber, '00123', 'leading zeros must survive'); eq(a.assets[0].purchaseDate, '2025-03-04');
    eq((await env.run('getInitialData', bayo.token)).assets.map(x => x.assetTag), ['MON-002']);
    const adm = await env.run('getInitialData', admin.token); eq(adm.assets.length, 2);
    assert(adm.assets.find(x => x.assetTag === 'LAP-001').notes.includes('INTERNAL'), 'admin should see notes');
  });
  await test('role/active changes take effect immediately, not after the session expires', async () => {
    const { env, ada } = await bootstrap();
    env.props.PROMOTE_EMAIL = 'ada@company.com'; await env.run('promoteToAdmin');
    eq((await env.run('getInitialData', ada.token)).user.role, 'admin', 'promotion should apply to the live session');
    env.props.USER_EMAIL = 'ada@company.com'; env.props.USER_ACCESS = 'disabled'; await env.run('setUserAccess');
    await rejects(env.run('getInitialData', ada.token), /not active/);
    await rejects(env.run('login', { email: 'ada@company.com', password: 'employee-pass-123' }), /incorrect/);
  });
  await test('tampering with sheet role text/case still resolves safely', async () => {
    const { env, ada } = await bootstrap();
    const idx = env.sheets.Users.rows[0].indexOf('role');
    const row = env.sheets.Users.rows.find(r => r[2] === 'ada@company.com'); row[idx] = ' ADMIN ';
    eq((await env.run('getInitialData', ada.token)).user.role, 'admin');
    row[idx] = 'superuser'; eq((await env.run('getInitialData', ada.token)).user.role, 'employee', 'unknown role must NOT be admin');
  });
  await test('cannot remove the last active IT administrator', async () => {
    const { env } = await bootstrap();
    env.props.USER_EMAIL = 'it@company.com'; env.props.USER_ACCESS = 'disabled';
    await rejects(env.run('setUserAccess'), /last active/);
    env.props.USER_EMAIL = 'it@company.com'; env.props.USER_ACCESS = 'employee';
    await rejects(env.run('setUserAccess'), /last active/);
  });
  await test('owner tools exposed to the browser take no input from the caller', async () => {
    const { env, ada } = await bootstrap();
    const before = JSON.stringify(env.sheets.Users.rows);
    // A hostile visitor calls them with arguments from the console; nothing may change.
    await rejects(env.run('promoteToAdmin', 'ada@company.com'), /Set PROMOTE_EMAIL/);
    await rejects(env.run('setUserAccess', 'ada@company.com', 'admin'), /Set USER_EMAIL/);
    await rejects(env.run('createInitialAdmin', 'evil@x.com', 'pw'), /Set ADMIN_EMAIL/);
    eq(JSON.stringify(env.sheets.Users.rows), before, 'users sheet must be untouched');
    eq((await env.run('getInitialData', ada.token)).user.role, 'employee');
  });
  await test('internal helpers (trailing underscore) are not callable from the browser', async () => {
    const { env } = await bootstrap();
    for (const f of ['requireUser_', 'appendObject_', 'readObjects_', 'hashPassword_']) await rejects(env.run(f), /not a function/);
  });

  console.log('\nTicket workflow (employee -> IT Support -> employee)');
  await test('full lifecycle with activity history visible to both sides', async () => {
    const { env, admin, ada } = await bootstrap();
    await env.run('saveAsset', admin.token, { assetTag: 'LAP-001', assetType: 'Laptop', assignedToEmail: 'ada@company.com' });
    const { ticketId } = await env.run('createTicket', ada.token, { title: 'Laptop will not boot', description: 'Black screen', category: 'Hardware', priority: 'High', assetTag: 'lap-001' });
    assert(/^IT-\d{4}-[0-9A-F]{6}$/.test(ticketId), 'ticket id format ' + ticketId);

    let adm = await env.run('getInitialData', admin.token);
    eq(adm.tickets.length, 1); eq(adm.tickets[0].assetTag, 'LAP-001'); eq(adm.stats.newCount, 1);
    eq(adm.assets[0].openTickets, 1);
    eq((await env.run('getInitialData', ada.token)).assets[0].openTickets, 1);

    await env.run('updateTicket', admin.token, { ticketId, status: 'In Progress', assignedTo: 'IT@company.com', message: 'Looking at it now' });
    await env.run('updateTicket', admin.token, { ticketId, status: 'Waiting for Employee', message: 'Is the charger light on?' });
    await env.run('addEmployeeUpdate', ada.token, { ticketId, message: 'Yes, green light' });
    let mine = (await env.run('getInitialData', ada.token)).tickets[0];
    eq(mine.status, 'In Progress', 'employee reply returns the ticket to the technician queue');
    eq(mine.assignedTo, 'it@company.com');

    await rejects(env.run('updateTicket', admin.token, { ticketId, status: 'Resolved' }), /Record the resolution/);
    await env.run('updateTicket', admin.token, { ticketId, status: 'Resolved', resolution: 'Replaced faulty power adapter.' });
    mine = (await env.run('getInitialData', ada.token)).tickets[0];
    eq(mine.status, 'Resolved'); eq(mine.resolution, 'Replaced faulty power adapter.'); assert(mine.resolvedAt, 'resolvedAt not set');
    eq((await env.run('getInitialData', ada.token)).assets[0].openTickets, 0, 'resolved tickets are no longer open');
    eq((await env.run('getInitialData', admin.token)).stats.resolved, 1);

    const hist = await env.run('getTicketUpdates', ada.token, ticketId);
    eq(hist.length, 5, 'history length (submitted, in progress, waiting, employee reply, resolved)');
    eq(hist[0].message, 'Complaint submitted.'); eq(hist[0].authorRole, 'Employee'); eq(hist[0].authorName, 'Ada Obi');
    assert(hist.some(h => h.authorRole === 'IT Support' && /Looking at it now/.test(h.message)));
    assert(hist.some(h => /Replaced faulty power adapter/.test(h.message)), 'resolution must appear in history');
    eq(hist.map(h => h.createdAtTs).slice().sort((a, b) => a - b), hist.map(h => h.createdAtTs), 'history must be chronological');
    eq(JSON.stringify(await env.run('getTicketUpdates', admin.token, ticketId)), JSON.stringify(hist), 'admin sees the same history');
  });
  await test('re-opening a resolved ticket clears resolvedAt; closing needs a resolution', async () => {
    const { env, admin, ada } = await bootstrap();
    const { ticketId } = await env.run('createTicket', ada.token, { title: 't', description: 'd', category: 'Other' });
    await env.run('updateTicket', admin.token, { ticketId, status: 'Resolved', resolution: 'Fixed' });
    await env.run('updateTicket', admin.token, { ticketId, status: 'In Progress', message: 'Problem came back' });
    eq((await env.run('getInitialData', ada.token)).tickets[0].resolvedAt, '');
    await env.run('updateTicket', admin.token, { ticketId, status: 'Closed', resolution: 'Confirmed fixed' });
    assert((await env.run('getInitialData', ada.token)).tickets[0].resolvedAt, 'closing sets resolvedAt');
    await rejects(env.run('addEmployeeUpdate', ada.token, { ticketId, message: 'one more thing' }), /closed/);
  });
  await test('updateTicket validation: unknown status, non-technician assignee, no-op', async () => {
    const { env, admin, ada } = await bootstrap();
    const { ticketId } = await env.run('createTicket', ada.token, { title: 't', description: 'd', category: 'Other' });
    await rejects(env.run('updateTicket', admin.token, { ticketId, status: 'Bananas' }), /Unknown status/);
    await rejects(env.run('updateTicket', admin.token, { ticketId, assignedTo: 'ada@company.com' }), /technician/);
    await rejects(env.run('updateTicket', admin.token, { ticketId, status: 'New' }), /no changes/);
    await rejects(env.run('updateTicket', admin.token, { ticketId: 'IT-0000-NOPE', status: 'Closed' }), /not found/);
  });
  await test('createTicket validation and no half-saved data on failure', async () => {
    const { env, ada } = await bootstrap();
    await rejects(env.run('createTicket', ada.token, { title: '', description: 'd', category: 'Other' }), /Complete/);
    await rejects(env.run('createTicket', ada.token, { title: 't', description: 'd', category: 'Not a category' }), /Complete/);
    await rejects(env.run('createTicket', ada.token, { title: 't', description: 'd', category: 'Other', assetTag: "x');alert(1);//" }), /asset tag/);
    eq(env.sheets.Tickets.rows.length, 1, 'rejected tickets must not leave rows behind');
    eq(env.sheets.TicketUpdates.rows.length, 1);
  });
  await test('ticket history is written for every created ticket (the original backend bug)', async () => {
    const { env, ada } = await bootstrap();
    const { ticketId } = await env.run('createTicket', ada.token, { title: 't', description: 'd', category: 'Other' });
    const h = await env.run('getTicketUpdates', ada.token, ticketId); eq(h.length, 1);
    assert(src.includes('TICKET_UPDATES:') && !/CONFIG\.SHEETS\.UPDATES/.test(src));
    for (const m of src.matchAll(/CONFIG\.SHEETS\.([A-Z_]+)/g)) assert(env.sandbox.__CONFIG.SHEETS[m[1]], 'CONFIG.SHEETS.' + m[1] + ' is undefined');
  });

  console.log('\nData integrity (Google Sheets quirks)');
  await test('formulas typed into tickets are stored as inert text', async () => {
    const { env, ada } = await bootstrap();
    const evil = '=IMPORTXML("http://evil.example","//a")';
    const { ticketId } = await env.run('createTicket', ada.token, { title: evil, description: '+cmd|calc', category: 'Other' });
    eq(env.sheets.Tickets.formulaWrites + env.sheets.TicketUpdates.formulaWrites + env.sheets.Users.formulaWrites, 0, 'a formula cell was created');
    eq((await env.run('getInitialData', ada.token)).tickets[0].title, evil);
    const n = await env.run('registerUser', { fullName: '=1+1', email: 'f@y.com', department: 'Sales', password: 'employee-pass-123' });
    eq(env.sheets.Users.formulaWrites, 0); eq(n.user.fullName, '=1+1');
  });
  await test('asset with a purchase date reaches the browser (Date objects would blank the whole dashboard)', async () => {
    const { env, admin } = await bootstrap();
    await env.run('saveAsset', admin.token, { assetTag: 'PRN-9', purchaseDate: '2025-03-04' });
    const d = await env.run('getInitialData', admin.token); eq(d.assets[0].purchaseDate, '2025-03-04');
    // even if someone types a real date straight into the sheet
    const r = env.sheets.Assets.rows[1]; r[env.sheets.Assets.rows[0].indexOf('purchaseDate')] = require('vm').runInContext("new Date('2024-01-02T00:00:00')", env.sandbox);
    const d2 = await env.run('getInitialData', admin.token); assert(/^2024-01-0[12]$/.test(d2.assets[0].purchaseDate), d2.assets[0].purchaseDate);
  });
  await test('asset edit keeps the same row, id and created date; tag lookup is case-insensitive', async () => {
    const { env, admin } = await bootstrap();
    eq((await env.run('saveAsset', admin.token, { assetTag: 'lap-7', assetType: 'Laptop' })).created, true);
    const id1 = env.sheets.Assets.rows[1][0];
    eq((await env.run('saveAsset', admin.token, { assetTag: 'LAP-7', assetType: 'Laptop', condition: 'Faulty', assignedToEmail: 'ada@company.com' })).created, false);
    eq(env.sheets.Assets.rows.length, 2); eq(env.sheets.Assets.rows[1][0], id1);
    eq((await env.run('getInitialData', admin.token)).assets[0].condition, 'Faulty');
    await rejects(env.run('saveAsset', admin.token, { assetTag: 'A1', assignedToEmail: 'not-an-email' }), /not valid/);
    await rejects(env.run('saveAsset', admin.token, { assetTag: 'A1', purchaseDate: '04/03/2025' }), /date/);
    await rejects(env.run('saveAsset', admin.token, { assetTag: '' }), /required/);
  });
  await test('concurrent writes are serialised with a lock and the lock is always released', async () => {
    const { env, ada } = await bootstrap();
    const before = env.lockAcquired || 0;
    await Promise.all([1, 2, 3].map(i => env.run('createTicket', ada.token, { title: 't' + i, description: 'd', category: 'Other' })));
    assert((env.lockAcquired || 0) >= before + 3, 'writes did not take the lock');
    await rejects(env.run('createTicket', ada.token, { title: '', description: '', category: '' }), /Complete/);
    await env.run('createTicket', ada.token, { title: 'after error', description: 'd', category: 'Other' }); // would throw "Lock timeout" if leaked
    eq((await env.run('getInitialData', ada.token)).tickets.length, 4);
    const ids = (await env.run('getInitialData', ada.token)).tickets.map(t => t.ticketId); eq(new Set(ids).size, ids.length, 'duplicate ticket ids');
  });
  await test('ticket list is sortable by real timestamp (not by the formatted text)', async () => {
    const { env, ada } = await bootstrap();
    await env.run('createTicket', ada.token, { title: 'first', description: 'd', category: 'Other' });
    await new Promise(r => setTimeout(r, 15));
    await env.run('createTicket', ada.token, { title: 'second', description: 'd', category: 'Other' });
    const t = (await env.run('getInitialData', ada.token)).tickets;
    assert(t.every(x => typeof x.createdAtTs === 'number' && x.createdAtTs > 0)); assert(t[1].createdAtTs > t[0].createdAtTs);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFAILURES:\n- ' + failures.join('\n- ')); process.exit(1); }
})();
