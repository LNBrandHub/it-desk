/**
 * End-to-end test: real browser (Chromium via Playwright) -> real Index.html -> real Code.gs (in the emulator).
 * Usage: node e2e.js [app-dir] [screenshot-dir]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { makeEnv } = require('./gas-mock');

const appDir = process.argv[2] || path.join(__dirname, '..', 'it-helpdesk-asset-management');
const shotDir = process.argv[3] || path.join(__dirname, 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });
const html = fs.readFileSync(path.join(appDir, 'Index.html'), 'utf8');

const env = makeEnv(); env.props.DATABASE_ID = 'TEST_DB'; env.load(fs.readFileSync(path.join(appDir, 'Code.gs'), 'utf8'));

let pass = 0, fail = 0; const problems = [];
async function step(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; problems.push(name + ' -> ' + e.message.split('\n')[0]); console.log('  FAIL ' + name + '\n         ' + e.message.split('\n')[0]); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const SHIM = `
(function(){
  function make(s,f){ return new Proxy({}, { get(_, name){
    if (name === 'withSuccessHandler') return fn => make(fn, f);
    if (name === 'withFailureHandler') return fn => make(s, fn);
    return (...args) => { window.__gas(name, JSON.stringify(args)).then(r => { r = JSON.parse(r); if (r.error) { f && f({message: r.error}); } else { s && s(r.result); } }); };
  }}); }
  window.google = { script: { run: make(null, null) } };
})();`;

async function openApp(browser, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = []; page.dialogs = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', async d => { page.dialogs.push(d.message()); await d.dismiss(); });
  await page.exposeFunction('__gas', async (name, args) => {
    try { return JSON.stringify({ result: await env.run(name, ...JSON.parse(args)) }); }
    catch (e) { return JSON.stringify({ error: e.message }); }
  });
  await page.addInitScript(SHIM);
  await page.route('http://app.test/**', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://app.test/');
  return page;
}
const visible = (page, sel, t = 4000) => page.locator(sel).first().waitFor({ state: 'visible', timeout: t });
const text = async (page, sel) => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();
async function signIn(page, email, pw) {
  await page.fill('#loginEmail', email); await page.fill('#loginPassword', pw); await page.click('#loginBtn');
  await visible(page, '#application');
}
const navTexts = page => page.locator('#nav button').allInnerTexts();
async function nav(page, label) { await page.locator('#nav button', { hasText: label }).click(); }

(async () => {
  // ---- owner setup, exactly as the README tells you to do it ----
  await env.run('setupDatabase');
  Object.assign(env.props, { ADMIN_EMAIL: 'it@company.com', ADMIN_NAME: 'Tunde IT', ADMIN_PASSWORD: 'A-strong-admin-pass-1' });
  await env.run('createInitialAdmin');

  const browser = await chromium.launch();
  const emp = await openApp(browser);
  const adm = await openApp(browser);
  let ticketRef = '';

  console.log('\nEmployee: register -> log in');
  await step('page loads with no JavaScript errors and shows the sign-in form', async () => {
    await visible(emp, '#loginForm'); assert(emp.errors.length === 0, 'JS errors: ' + emp.errors.join(' | '));
  });
  await step('registration rejects a short password with a visible message', async () => {
    await emp.click('text=Create an employee account'); await visible(emp, '#regDept');
    assert((await emp.locator('#regDept option').count()) >= 8, 'departments not loaded');
    await emp.fill('#regName', 'Ada Obi'); await emp.fill('#regEmail', 'ada@company.com'); await emp.selectOption('#regDept', 'Sales'); await emp.fill('#regPassword', 'short');
    await emp.click('#regBtn'); await visible(emp, '#authError');
    assert(/10 characters/.test(await text(emp, '#authError')));
  });
  await step('registration succeeds and signs the employee straight in', async () => {
    await emp.fill('#regPassword', 'employee-pass-123'); await emp.click('#regBtn'); await visible(emp, '#application');
    assert(/Ada Obi · EMPLOYEE/.test(await text(emp, '#userChip')), await text(emp, '#userChip'));
  });
  await step('employee menu: Overview, My Complaints, My Equipment, Report an Issue (no admin pages)', async () => {
    const n = await navTexts(emp); assert(JSON.stringify(n) === JSON.stringify(['Overview', 'My Complaints', 'My Equipment', 'Report an Issue']), JSON.stringify(n));
  });
  await step('My Equipment shows a clear empty state before anything is assigned', async () => {
    await nav(emp, 'My Equipment'); await visible(emp, '.empty'); assert(/No equipment is assigned to you yet/.test(await text(emp, '.empty')));
    assert(/ada@company\.com/.test(await text(emp, '.empty')), 'should tell her which email IT must use');
  });

  console.log('\nIT Support: log in -> manage assets');
  await step('IT Support signs in and sees admin menu', async () => {
    await signIn(adm, 'it@company.com', 'A-strong-admin-pass-1');
    const n = await navTexts(adm); assert(JSON.stringify(n) === JSON.stringify(['Overview', 'All Tickets', 'Asset Register', 'Report an Issue']), JSON.stringify(n));
    assert(/IT SUPPORT/.test(await text(adm, '#userChip')));
  });
  await step('IT adds a laptop assigned to Ada with a purchase date (the case that broke the original dashboard)', async () => {
    await nav(adm, 'Asset Register'); await adm.click('text=+ Add asset'); await visible(adm, '#aTag');
    await adm.fill('#aTag', 'lap-001'); await adm.fill('#aType', 'Laptop'); await adm.fill('#aModel', 'Dell Latitude 5420'); await adm.fill('#aSerial', '00123X');
    await adm.fill('#aEmail', 'Ada@Company.com'); await adm.selectOption('#aDept', 'Sales'); await adm.selectOption('#aCondition', 'Good'); await adm.fill('#aDate', '2025-03-04'); await adm.fill('#aNotes', 'INTERNAL warranty note');
    await adm.click('text=Save asset'); await adm.locator('#assetTable td strong', { hasText: 'LAP-001' }).waitFor();
    assert(/Ada@Company|ada@company\.com/i.test(await text(adm, '#assetTable')));
  });
  await step('IT can edit the asset (tag locked) and mark condition', async () => {
    await adm.locator('button', { hasText: 'Edit' }).first().click(); await visible(adm, '#aTag');
    assert(await adm.locator('#aTag').isDisabled(), 'tag must be locked when editing');
    assert((await adm.inputValue('#aDate')) === '2025-03-04', 'purchase date not restored');
    await adm.selectOption('#aCondition', 'Fair'); await adm.click('text=Save asset');
    await adm.locator('#assetTable .badge', { hasText: 'Fair' }).waitFor();
  });
  await step('invalid asset input shows an inline error and keeps the dialog open', async () => {
    await adm.click('text=+ Add asset'); await visible(adm, '#aTag'); await adm.fill('#aTag', "x');alert(1);//"); await adm.click('text=Save asset');
    await visible(adm, '#modalNotice .error'); assert(/asset tag may only contain/.test(await text(adm, '#modalNotice')));
    await adm.click('.close');
  });

  console.log('\nEmployee: My Equipment -> report a fault -> track');
  await step('after re-login My Equipment shows the laptop card without internal notes', async () => {
    await emp.click('text=Sign out'); await visible(emp, '#loginForm'); await signIn(emp, 'ada@company.com', 'employee-pass-123');
    await nav(emp, 'My Equipment'); await visible(emp, '.equip');
    const card = await text(emp, '.equip');
    assert(/LAP-001/.test(card) && /Dell Latitude 5420/.test(card) && /00123X/.test(card) && /2025-03-04/.test(card) && /Fair/.test(card), card);
    assert(!/INTERNAL/.test(await emp.content()), 'internal notes visible to employee');
    await emp.screenshot({ path: path.join(shotDir, '1-employee-my-equipment.png') });
  });
  await step('"Report a fault" opens the form with the laptop, Hardware and a title pre-filled', async () => {
    await emp.click('text=Report a fault'); await visible(emp, '#fTitle');
    assert((await emp.inputValue('#fAssetSel')) === 'LAP-001', 'asset not preselected');
    assert((await emp.inputValue('#fCategory')) === 'Hardware');
    assert(/Laptop/.test(await emp.inputValue('#fTitle')));
  });
  await step('submitting with the description missing shows an error and creates nothing', async () => {
    await emp.click('#submitTicketBtn'); await visible(emp, '#formNotice .error'); assert(/Complete the title/.test(await text(emp, '#formNotice')));
  });
  await step('employee submits the complaint and gets a ticket reference', async () => {
    await emp.fill('#fTitle', 'Laptop will not power on'); await emp.selectOption('#fPriority', 'High'); await emp.fill('#fDescription', 'Black screen since this morning. Charger light is off.');
    await emp.click('#submitTicketBtn'); await visible(emp, '.notice.success');
    ticketRef = (await text(emp, 'h2')).match(/IT-\d{4}-[0-9A-F]{6}/)[0]; assert(ticketRef);
  });
  await step('complaint appears in My Complaints; the laptop card now shows 1 open complaint', async () => {
    await emp.click('text=View my complaints'); await emp.locator('#ticketTable td strong', { hasText: ticketRef }).waitFor();
    await nav(emp, 'My Equipment'); await visible(emp, '.equip'); assert(/Open complaints\s*1/.test(await text(emp, '.equip')), await text(emp, '.equip'));
  });

  console.log('\nIT Support: view -> assign -> update -> resolve');
  await step('IT Support (still signed in) sees the new complaint just by opening All Tickets', async () => {
    // IT Support has been logged in the whole time: simply opening the page must pull in the new complaint.
    await nav(adm, 'Overview'); await nav(adm, 'All Tickets'); await adm.locator('#ticketTable td strong', { hasText: ticketRef }).waitFor();
    assert(/Ada Obi/.test(await text(adm, '#ticketTable')) && /High/.test(await text(adm, '#ticketTable')));
    await adm.screenshot({ path: path.join(shotDir, '2-it-all-tickets.png') });
  });
  await step('IT opens the ticket, assigns a technician and sets In Progress with a note', async () => {
    await adm.locator('#ticketTable button', { hasText: 'Open' }).first().click(); await visible(adm, '#mStatus');
    assert((await adm.locator('#mAssigned option').allInnerTexts()).some(t => /Tunde IT/.test(t)), 'technician list missing');
    await adm.selectOption('#mStatus', 'In Progress'); await adm.selectOption('#mAssigned', 'it@company.com'); await adm.fill('#mMessage', 'Collecting laptop from your desk.');
    await adm.click('text=Save changes'); await visible(adm, '#mStatus');
    assert(/Collecting laptop/.test(await text(adm, '.modal')) && /Assigned to it@company\.com/.test(await text(adm, '.modal')), 'history not updated');
  });
  await step('resolving without a resolution is blocked with an inline message', async () => {
    await adm.selectOption('#mStatus', 'Resolved'); await adm.click('text=Save changes'); await visible(adm, '#modalNotice .error');
    assert(/Record the resolution/.test(await text(adm, '#modalNotice')));
  });
  await step('IT records the resolution and the ticket is Resolved', async () => {
    await adm.fill('#mResolution', 'Replaced faulty power adapter and tested.'); await adm.click('text=Save changes'); await visible(adm, '.resolution');
    assert(/Resolved/.test(await text(adm, '.modal')) && /power adapter/.test(await text(adm, '.resolution')));
    await adm.screenshot({ path: path.join(shotDir, '3-it-ticket-resolved.png') });
    await adm.click('.close');
  });

  console.log('\nEmployee: receives resolution');
  await step('employee sees the resolution, technician, full history, and can still message IT', async () => {
    await emp.click('text=Sign out'); await visible(emp, '#loginForm'); await signIn(emp, 'ada@company.com', 'employee-pass-123');
    await nav(emp, 'My Complaints'); await emp.locator('#ticketTable button', { hasText: 'Open' }).first().click(); await visible(emp, '.resolution');
    const m = await text(emp, '.modal');
    assert(/Replaced faulty power adapter/.test(m) && /Resolved/.test(m) && /it@company\.com/.test(m), m.slice(0, 300));
    assert(/Complaint submitted/.test(m) && /Collecting laptop from your desk/.test(m), 'history incomplete');
    assert((await emp.locator('#mStatus').count()) === 0, 'employee must not see status controls');
    await emp.fill('#mMessage', 'Thanks, it works now.'); await emp.click('text=Send message'); await emp.locator('.modal', { hasText: 'Thanks, it works now.' }).waitFor();
    await emp.screenshot({ path: path.join(shotDir, '4-employee-sees-resolution.png') });
    await emp.click('.close');
  });
  await step('Refresh button picks up changes made by the other side without signing out', async () => {
    await emp.locator('#ticketTable button', { hasText: 'Open' }).count().catch(() => 0);
    await nav(emp, 'My Complaints'); await emp.click('text=↻ Refresh'); await visible(emp, '#ticketTable table');
    assert(/Resolved/.test(await text(emp, '#ticketTable')), 'resolved status not visible after refresh');
  });
  await step('laptop card shows 0 open complaints again', async () => {
    await nav(emp, 'My Equipment'); await visible(emp, '.equip'); assert(/Open complaints\s*0/.test(await text(emp, '.equip')));
  });

  console.log('\nSafety & resilience');
  await step('hostile text in a ticket is shown as text and never executes', async () => {
    await nav(emp, 'Report an Issue'); await visible(emp, '#fTitle');
    await emp.fill('#fTitle', '<img src=x onerror="window.__xss=1"> "quoted" \'single\''); await emp.fill('#fDescription', '<script>window.__xss=2</script> & more');
    await emp.click('#submitTicketBtn'); await visible(emp, '.notice.success'); await emp.click('text=View my complaints');
    await emp.locator('#ticketTable button', { hasText: 'Open' }).first().click(); await visible(emp, '.modal');
    assert(!(await emp.evaluate(() => window.__xss)), 'script executed!'); assert(emp.errors.length === 0, emp.errors.join('|'));
    assert(/quoted/.test(await text(emp, '.modal')));
    await emp.click('.close');
  });
  await step('employee page is not able to reach admin data even by calling the backend directly', async () => {
    const r = await emp.evaluate(async () => {
      const t = sessionStorage.getItem('itdesk_token');
      const call = (n, ...a) => new Promise(res => google.script.run.withSuccessHandler(v => res({ ok: v })).withFailureHandler(e => res({ err: e.message }))[n](...a));
      const all = await call('getInitialData', t);
      return { saveAsset: await call('saveAsset', t, { assetTag: 'EVIL-1' }), update: await call('updateTicket', t, { ticketId: all.ok.tickets[0].ticketId, status: 'Closed', resolution: 'x' }),
        techs: all.ok.technicians.length, otherTickets: all.ok.tickets.filter(x => x.employeeEmail !== 'ada@company.com').length, assetsAll: all.ok.assets.length };
    });
    assert(/Only IT Support/.test(r.saveAsset.err) && /Only IT Support/.test(r.update.err), JSON.stringify(r));
    assert(r.techs === 0 && r.otherTickets === 0 && r.assetsAll === 1, JSON.stringify(r));
  });
  await step('expired session sends the user back to sign-in with a clear message (no stuck screen)', async () => {
    Object.keys(env.cache).filter(k => k.startsWith('session_')).forEach(k => delete env.cache[k]);
    await nav(emp, 'Report an Issue'); await emp.fill('#fTitle', 'x'); await emp.fill('#fDescription', 'y'); await emp.click('#submitTicketBtn');
    await visible(emp, '#loginForm'); assert(/session has expired/.test(await text(emp, '#authError')), await text(emp, '#authError'));
    await signIn(emp, 'ada@company.com', 'employee-pass-123');
  });
  await step('wrong password shows an error; Enter key signs in', async () => {
    await emp.click('text=Sign out'); await visible(emp, '#loginForm');
    await emp.fill('#loginEmail', 'ada@company.com'); await emp.fill('#loginPassword', 'wrong-password'); await emp.press('#loginPassword', 'Enter');
    await visible(emp, '#authError'); assert(/incorrect/.test(await text(emp, '#authError')));
    await emp.fill('#loginPassword', 'employee-pass-123'); await emp.press('#loginPassword', 'Enter'); await visible(emp, '#application');
  });
  await step('ticket list sorts newest first and search/status filter work', async () => {
    await nav(emp, 'My Complaints'); await visible(emp, '#ticketTable table');
    const first = await emp.locator('#ticketTable tbody tr').first().innerText(); assert(/quoted/.test(first), 'newest ticket should be first: ' + first.slice(0, 60));
    await emp.fill('#ticketSearch', 'power on'); assert((await emp.locator('#ticketTable tbody tr').count()) === 1);
    await emp.fill('#ticketSearch', ''); await emp.selectOption('#statusFilter', 'Resolved'); assert((await emp.locator('#ticketTable tbody tr').count()) === 1);
  });
  await step('mobile layout (390px) has no horizontal page scroll on every employee screen', async () => {
    const m = await openApp(browser, { width: 390, height: 800 }); await signIn(m, 'ada@company.com', 'employee-pass-123');
    for (const label of ['Overview', 'My Complaints', 'My Equipment', 'Report an Issue']) {
      await nav(m, label); await m.waitForTimeout(150);
      const o = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert(o <= 1, label + ' overflows by ' + o + 'px');
    }
    await nav(m, 'My Equipment'); await m.screenshot({ path: path.join(shotDir, '5-mobile-my-equipment.png') });
  });
  await step('no JavaScript errors or unexpected alert() popups occurred during the whole run', async () => {
    assert(emp.errors.length === 0 && adm.errors.length === 0, 'errors: ' + emp.errors.concat(adm.errors).join(' | '));
    assert(emp.dialogs.length === 0 && adm.dialogs.length === 0, 'dialogs: ' + emp.dialogs.concat(adm.dialogs).join(' | '));
  });

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFAILURES:\n- ' + problems.join('\n- ')); process.exit(1); }
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
