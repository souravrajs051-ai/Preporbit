require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const dataDir = path.resolve(path.dirname(process.env.DATABASE_PATH || './data/preporbit.sqlite'));
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.resolve(process.env.DATABASE_PATH || './data/preporbit.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('student','mentor','admin')),
 status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS plans (
 id INTEGER PRIMARY KEY AUTOINCREMENT, plan_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
 duration_months INTEGER NOT NULL, list_price INTEGER NOT NULL, sale_price INTEGER NOT NULL,
 description TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS offers (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, code TEXT, description TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, starts_at TEXT, ends_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS purchases (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), plan_id INTEGER NOT NULL REFERENCES plans(id),
 amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'INR', razorpay_order_id TEXT UNIQUE,
 razorpay_payment_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'created', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 paid_at TEXT
);
CREATE TABLE IF NOT EXISTS mentor_tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT, mentor_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL,
 details TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'assigned', due_date TEXT, month_key TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS mentor_payouts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, mentor_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL,
 month_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, action TEXT NOT NULL, details TEXT DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS site_settings (
 setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const defaultPlans = [
 ['six-months','6-Month Orbit Pass',6,999,299,'Mock-test access, study planning, progress tracking and mentorship features.'],
 ['one-year','1-Year Orbit Pass',12,1999,499,'Long-term preparation support, mock-test access, study planning and progress tracking.']
];
for (const p of defaultPlans) db.prepare(`INSERT OR IGNORE INTO plans (plan_key,title,duration_months,list_price,sale_price,description) VALUES (?,?,?,?,?,?)`).run(...p);
const defaultSettings = { hero_kicker: 'YOUR NEXT BIG LEAP STARTS HERE', hero_title: 'Big dreams. Better plans. Brighter futures.', hero_subtitle: 'Meet the study companion that makes exam prep feel less overwhelming. Get a plan, practise with purpose, learn from mentors and see your progress—one small win at a time.', announcement: '', support_email: '' };
for (const [key,value] of Object.entries(defaultSettings)) q('INSERT OR IGNORE INTO site_settings(setting_key,setting_value) VALUES(?,?)').run(key,value);
const adminName = process.env.ADMIN_USERNAME;
const adminPassword = process.env.ADMIN_PASSWORD;
if (adminName && adminPassword && !db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()) {
  const hash = bcrypt.hashSync(adminPassword, 12);
  db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')").run('PrepOrbit Administrator', adminName.toLowerCase(), hash);
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '200kb', verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(session({
 secret: process.env.SESSION_SECRET || 'development-only-change-this-secret-before-deploying',
 resave: false, saveUninitialized: false, name: 'preporbit.sid',
 cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000*60*60*12 },
 store: new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir })
}));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
const authLimiter = rateLimit({ windowMs: 15*60*1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Please wait 15 minutes and try again.' } });
const payLimiter = rateLimit({ windowMs: 60*1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });
const q = (sql) => db.prepare(sql);
const audit = (actor, action, details='') => q('INSERT INTO audit_log(actor_id,action,details) VALUES(?,?,?)').run(actor?.id || null, action, String(details).slice(0,1000));
const safeUser = (u) => u && ({ id:u.id, name:u.name, email:u.email, role:u.role, status:u.status, created_at:u.created_at });
function requireAuth(req,res,next){ if(!req.session.user) return res.status(401).json({error:'Please sign in first.'}); next(); }
function requireRole(...roles){ return (req,res,next)=>{ if(!req.session.user || !roles.includes(req.session.user.role)) return res.status(403).json({error:'You do not have permission for this action.'}); next(); }; }
function razorpayClient(){
 if(!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_ID.includes('replace_me')) return null;
 return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

app.get('/api/health', (req,res)=>res.json({ok:true, service:'PrepOrbit', mode:process.env.NODE_ENV || 'development'}));
app.get('/api/config', (req,res)=>res.json({keyId:process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_ID.includes('replace_me') ? process.env.RAZORPAY_KEY_ID : null, user:safeUser(req.session.user), gatewayReady:!!razorpayClient()}));
app.get('/api/plans', (req,res)=>res.json(q('SELECT id,plan_key,title,duration_months,list_price,sale_price,description FROM plans WHERE active=1 ORDER BY duration_months').all()));
app.get('/api/site-settings', (req,res)=>{ const rows=q('SELECT setting_key,setting_value FROM site_settings').all(); res.json(Object.fromEntries(rows.map(r=>[r.setting_key,r.setting_value]))); });
app.get('/api/offers', (req,res)=>res.json(q("SELECT id,title,code,description,starts_at,ends_at FROM offers WHERE active=1 AND (starts_at IS NULL OR datetime(starts_at)<=datetime('now')) AND (ends_at IS NULL OR datetime(ends_at)>=datetime('now')) ORDER BY id DESC").all()));

app.post('/api/auth/register', authLimiter, async (req,res)=>{
 const {name,email,password}=req.body || {};
 if(!name || String(name).trim().length<2 || !email || !/^\S+@\S+\.\S+$/.test(email) || !password || String(password).length<10) return res.status(400).json({error:'Enter your name, a valid email and a password of at least 10 characters.'});
 const normalized=String(email).trim().toLowerCase();
 if(q('SELECT id FROM users WHERE email=?').get(normalized)) return res.status(409).json({error:'An account with this email already exists.'});
 const hash=await bcrypt.hash(String(password),12);
 const result=q("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'student')").run(String(name).trim().slice(0,100),normalized,hash);
 const user=q('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid); req.session.user=safeUser(user); audit(user,'student.registered'); res.status(201).json({user:req.session.user});
});
app.post('/api/mentor/register', authLimiter, async (req,res)=>{
 const {name,email,password,subjects,experience}=req.body || {};
 if(!name || !email || !/^\S+@\S+\.\S+$/.test(email) || !password || String(password).length<10) return res.status(400).json({error:'Enter your name, valid email and a password of at least 10 characters.'});
 const normalized=String(email).trim().toLowerCase(); if(q('SELECT id FROM users WHERE email=?').get(normalized)) return res.status(409).json({error:'This email is already registered.'});
 const hash=await bcrypt.hash(String(password),12);
 const result=q("INSERT INTO users(name,email,password_hash,role,status) VALUES(?,?,?,'mentor','pending')").run(String(name).trim().slice(0,100),normalized,hash);
 audit({id:result.lastInsertRowid},'mentor.application',JSON.stringify({subjects:String(subjects||'').slice(0,300),experience:String(experience||'').slice(0,1000)}));
 res.status(201).json({message:'Application received. Your mentor account will be available after admin verification.'});
});
app.post('/api/auth/login', authLimiter, async (req,res)=>{
 const {email,password}=req.body||{}; if(!email||!password) return res.status(400).json({error:'Enter your login details.'});
 const user=q('SELECT * FROM users WHERE email=?').get(String(email).trim().toLowerCase());
 if(!user || !(await bcrypt.compare(String(password),user.password_hash))) return res.status(401).json({error:'Email or password is incorrect.'});
 if(user.status==='pending') return res.status(403).json({error:'Your mentor application is awaiting admin approval.'});
 if(user.status==='suspended') return res.status(403).json({error:'This account is suspended. Contact PrepOrbit support.'});
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not start a secure session.'}); req.session.user=safeUser(user); audit(user,'auth.login'); res.json({user:req.session.user});});
});
app.post('/api/auth/logout', (req,res)=>req.session.destroy(()=>{res.clearCookie('preporbit.sid');res.json({ok:true});}));
app.get('/api/me', requireAuth, (req,res)=>res.json({user:req.session.user}));
app.post('/api/auth/change-password', requireAuth, authLimiter, async(req,res)=>{
 const {currentPassword,newPassword}=req.body||{}; if(!currentPassword||!newPassword||String(newPassword).length<10)return res.status(400).json({error:'New password must be at least 10 characters.'});
 const u=q('SELECT * FROM users WHERE id=?').get(req.session.user.id); if(!await bcrypt.compare(String(currentPassword),u.password_hash))return res.status(400).json({error:'Current password is incorrect.'});
 q('UPDATE users SET password_hash=? WHERE id=?').run(await bcrypt.hash(String(newPassword),12),u.id); audit(u,'password.changed'); res.json({ok:true});
});

app.post('/api/payments/create-order', requireAuth, payLimiter, async(req,res)=>{
 const plan=q('SELECT * FROM plans WHERE id=? AND active=1').get(Number(req.body.planId)); if(!plan)return res.status(404).json({error:'This plan is unavailable.'});
 const gateway=razorpayClient(); if(!gateway)return res.status(503).json({error:'Online checkout is not configured yet. Admin must add Razorpay keys to the private server environment.'});
 try {
  const order=await gateway.orders.create({amount:plan.sale_price*100,currency:'INR',receipt:`po_${req.session.user.id}_${Date.now()}`,notes:{userId:String(req.session.user.id),planKey:plan.plan_key}});
  const result=q("INSERT INTO purchases(user_id,plan_id,amount,razorpay_order_id,status) VALUES(?,?,?,?, 'created')").run(req.session.user.id,plan.id,plan.sale_price,order.id);
  res.json({orderId:order.id,amount:order.amount,currency:order.currency,keyId:process.env.RAZORPAY_KEY_ID,plan:{title:plan.title,price:plan.sale_price},purchaseId:result.lastInsertRowid});
 }catch(e){console.error('Order creation failed',e.message);res.status(502).json({error:'Could not create a payment order. Please try again later.'});}
});
app.post('/api/payments/verify', requireAuth, payLimiter, (req,res)=>{
 const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
 if(!razorpay_order_id||!razorpay_payment_id||!razorpay_signature)return res.status(400).json({error:'Payment verification details are missing.'});
 const purchase=q('SELECT * FROM purchases WHERE razorpay_order_id=? AND user_id=?').get(razorpay_order_id,req.session.user.id); if(!purchase)return res.status(404).json({error:'Payment order not found.'});
 const secret=process.env.RAZORPAY_KEY_SECRET; if(!secret || secret==='replace_me')return res.status(503).json({error:'Payment verification is not configured.'});
 const expected=crypto.createHmac('sha256',secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
 const a=Buffer.from(expected); const b=Buffer.from(String(razorpay_signature)); if(a.length!==b.length || !crypto.timingSafeEqual(a,b))return res.status(400).json({error:'Payment signature could not be verified.'});
 q("UPDATE purchases SET razorpay_payment_id=?,status='paid',paid_at=CURRENT_TIMESTAMP WHERE id=? AND status!='paid'").run(razorpay_payment_id,purchase.id); audit(req.session.user,'payment.verified',`purchase=${purchase.id}`); res.json({ok:true,message:'Payment verified. Your purchase is recorded.'});
});
app.post('/api/payments/webhook', (req,res)=>{
 const secret=process.env.RAZORPAY_WEBHOOK_SECRET; if(!secret || secret==='replace_me')return res.status(503).send('Webhook not configured');
 const signature=req.headers['x-razorpay-signature']; if(!signature)return res.status(400).send('Missing signature');
 const rawBody=req.rawBody; if(!rawBody)return res.status(400).send('Missing raw payload'); const expected=crypto.createHmac('sha256',secret).update(rawBody).digest('hex'); const a=Buffer.from(expected),b=Buffer.from(String(signature)); if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(400).send('Invalid signature');
 try { const event=JSON.parse(rawBody.toString()); if(event.event==='payment.captured'){const p=event.payload?.payment?.entity; if(p?.order_id)q("UPDATE purchases SET razorpay_payment_id=?,status='paid',paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP) WHERE razorpay_order_id=?").run(p.id,p.order_id);} if(event.event==='payment.failed'){const p=event.payload?.payment?.entity;if(p?.order_id)q("UPDATE purchases SET status='failed' WHERE razorpay_order_id=? AND status!='paid'").run(p.order_id);} res.json({received:true}); }catch(e){res.status(400).send('Invalid payload');}
});

app.get('/api/student/dashboard', requireAuth, requireRole('student'), (req,res)=>{
 const purchases=q(`SELECT p.id,p.amount,p.status,p.created_at,p.paid_at,pl.title,pl.duration_months FROM purchases p JOIN plans pl ON pl.id=p.plan_id WHERE p.user_id=? ORDER BY p.id DESC`).all(req.session.user.id);
 res.json({purchases,paidCount:purchases.filter(p=>p.status==='paid').length,totalPaid:purchases.filter(p=>p.status==='paid').reduce((s,p)=>s+p.amount,0)});
});
app.get('/api/mentor/dashboard', requireAuth, requireRole('mentor'), (req,res)=>{
 const month=new Date().toISOString().slice(0,7); const tasks=q('SELECT * FROM mentor_tasks WHERE mentor_id=? AND month_key=? ORDER BY id DESC').all(req.session.user.id,month);
 const payouts=q('SELECT * FROM mentor_payouts WHERE mentor_id=? ORDER BY month_key DESC,id DESC LIMIT 12').all(req.session.user.id);
 const completed=tasks.filter(t=>t.status==='completed').length;
 res.json({month,tasks,payouts,summary:{assigned:tasks.length,completed,pending:tasks.length-completed,completionRate:tasks.length?Math.round(completed/tasks.length*100):0}});
});
app.post('/api/mentor/tasks/:id/complete', requireAuth, requireRole('mentor'), (req,res)=>{
 const task=q('SELECT * FROM mentor_tasks WHERE id=? AND mentor_id=?').get(Number(req.params.id),req.session.user.id); if(!task)return res.status(404).json({error:'Task not found.'});
 q("UPDATE mentor_tasks SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(task.id); res.json({ok:true});
});

app.get('/api/admin/site-settings', requireAuth, requireRole('admin'), (req,res)=>{ const rows=q('SELECT setting_key,setting_value FROM site_settings').all(); res.json(Object.fromEntries(rows.map(r=>[r.setting_key,r.setting_value]))); });
app.put('/api/admin/site-settings', requireAuth, requireRole('admin'), (req,res)=>{ const allowed=['hero_kicker','hero_title','hero_subtitle','announcement','support_email']; for(const key of allowed){ if(req.body[key]!==undefined){ const value=String(req.body[key]).slice(0,key==='hero_subtitle'?1000:500); q('INSERT INTO site_settings(setting_key,setting_value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP').run(key,value); } } audit(req.session.user,'site.settings.updated',allowed.filter(k=>req.body[k]!==undefined).join(',')); res.json({ok:true}); });
app.get('/api/admin/overview', requireAuth, requireRole('admin'), (req,res)=>{
 res.json({students:q("SELECT COUNT(*) n FROM users WHERE role='student'").get().n,mentors:q("SELECT COUNT(*) n FROM users WHERE role='mentor' AND status='active'").get().n,pendingMentors:q("SELECT COUNT(*) n FROM users WHERE role='mentor' AND status='pending'").get().n,paidOrders:q("SELECT COUNT(*) n FROM purchases WHERE status='paid'").get().n,revenue:q("SELECT COALESCE(SUM(amount),0) n FROM purchases WHERE status='paid'").get().n,plans:q('SELECT * FROM plans ORDER BY duration_months').all(),recentPurchases:q('SELECT p.*,u.name student_name,u.email,pl.title plan_title FROM purchases p JOIN users u ON u.id=p.user_id JOIN plans pl ON pl.id=p.plan_id ORDER BY p.id DESC LIMIT 20').all()});
});
app.put('/api/admin/plans/:id', requireAuth, requireRole('admin'), (req,res)=>{
 const {title,list_price,sale_price,description,active}=req.body||{}; const id=Number(req.params.id);
 if(!title||!Number.isInteger(Number(list_price))||!Number.isInteger(Number(sale_price))||Number(list_price)<1||Number(sale_price)<1||Number(sale_price)>Number(list_price))return res.status(400).json({error:'Enter a title and valid prices; offer price must not exceed the original price.'});
 const result=q('UPDATE plans SET title=?,list_price=?,sale_price=?,description=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(String(title).slice(0,100),Number(list_price),Number(sale_price),String(description||'').slice(0,500),active?1:0,id); if(!result.changes)return res.status(404).json({error:'Plan not found.'}); audit(req.session.user,'plan.updated',`plan=${id}`);res.json({ok:true});
});
app.post('/api/admin/offers', requireAuth, requireRole('admin'), (req,res)=>{
 const {title,code,description,starts_at,ends_at,active}=req.body||{};if(!title||!description)return res.status(400).json({error:'Offer title and description are required.'});
 const r=q('INSERT INTO offers(title,code,description,active,starts_at,ends_at) VALUES(?,?,?,?,?,?)').run(String(title).slice(0,120),String(code||'').slice(0,40),String(description).slice(0,500),active===false?0:1,starts_at||null,ends_at||null);audit(req.session.user,'offer.created',`offer=${r.lastInsertRowid}`);res.status(201).json({id:r.lastInsertRowid});
});
app.get('/api/admin/offers', requireAuth, requireRole('admin'), (req,res)=>res.json(q('SELECT * FROM offers ORDER BY id DESC').all()));
app.put('/api/admin/offers/:id', requireAuth, requireRole('admin'), (req,res)=>{const {title,code,description,active,starts_at,ends_at}=req.body||{};if(!title||!description)return res.status(400).json({error:'Title and description are required.'});q('UPDATE offers SET title=?,code=?,description=?,active=?,starts_at=?,ends_at=? WHERE id=?').run(String(title).slice(0,120),String(code||'').slice(0,40),String(description).slice(0,500),active?1:0,starts_at||null,ends_at||null,Number(req.params.id));audit(req.session.user,'offer.updated',`offer=${req.params.id}`);res.json({ok:true});});
app.get('/api/admin/mentors', requireAuth, requireRole('admin'), (req,res)=>res.json(q("SELECT id,name,email,status,created_at FROM users WHERE role='mentor' ORDER BY id DESC").all()));
app.put('/api/admin/mentors/:id/status', requireAuth, requireRole('admin'), (req,res)=>{const {status}=req.body||{};if(!['active','pending','suspended'].includes(status))return res.status(400).json({error:'Invalid mentor status.'});const r=q("UPDATE users SET status=? WHERE id=? AND role='mentor'").run(status,Number(req.params.id));if(!r.changes)return res.status(404).json({error:'Mentor not found.'});audit(req.session.user,'mentor.status',`${req.params.id}:${status}`);res.json({ok:true});});
app.post('/api/admin/mentors', requireAuth, requireRole('admin'), async(req,res)=>{const {name,email,password}=req.body||{};if(!name||!email||!/^\S+@\S+\.\S+$/.test(email)||!password||String(password).length<10)return res.status(400).json({error:'Name, valid email and password of at least 10 characters required.'});const normalized=String(email).trim().toLowerCase();if(q('SELECT id FROM users WHERE email=?').get(normalized))return res.status(409).json({error:'Email already exists.'});const r=q("INSERT INTO users(name,email,password_hash,role,status) VALUES(?,?,?,'mentor','active')").run(String(name).slice(0,100),normalized,await bcrypt.hash(String(password),12));audit(req.session.user,'mentor.created',`mentor=${r.lastInsertRowid}`);res.status(201).json({id:r.lastInsertRowid});});
app.post('/api/admin/mentor-tasks', requireAuth, requireRole('admin'), (req,res)=>{const {mentor_id,title,details,due_date,month_key}=req.body||{};if(!mentor_id||!title)return res.status(400).json({error:'Choose a mentor and enter a task title.'});const mentor=q("SELECT id FROM users WHERE id=? AND role='mentor' AND status='active'").get(Number(mentor_id));if(!mentor)return res.status(404).json({error:'Active mentor not found.'});const month=month_key||new Date().toISOString().slice(0,7);const r=q('INSERT INTO mentor_tasks(mentor_id,title,details,due_date,month_key) VALUES(?,?,?,?,?)').run(mentor.id,String(title).slice(0,150),String(details||'').slice(0,1000),due_date||null,month);audit(req.session.user,'mentor.task.created',`task=${r.lastInsertRowid}`);res.status(201).json({id:r.lastInsertRowid});});
app.post('/api/admin/mentor-payouts', requireAuth, requireRole('admin'), (req,res)=>{const {mentor_id,amount,month_key,status,note}=req.body||{};if(!mentor_id||!Number.isInteger(Number(amount))||Number(amount)<0||!month_key)return res.status(400).json({error:'Mentor, valid amount and month are required.'});const r=q('INSERT INTO mentor_payouts(mentor_id,amount,month_key,status,note) VALUES(?,?,?,?,?)').run(Number(mentor_id),Number(amount),month_key,['pending','paid'].includes(status)?status:'pending',String(note||'').slice(0,500));audit(req.session.user,'mentor.payout.recorded',`payout=${r.lastInsertRowid}`);res.status(201).json({id:r.lastInsertRowid});});
app.get('/api/admin/mentor-tasks', requireAuth, requireRole('admin'), (req,res)=>res.json(q('SELECT t.*,u.name mentor_name FROM mentor_tasks t JOIN users u ON u.id=t.mentor_id ORDER BY t.id DESC LIMIT 200').all()));
app.get('/api/admin/mentor-payouts', requireAuth, requireRole('admin'), (req,res)=>res.json(q('SELECT p.*,u.name mentor_name FROM mentor_payouts p JOIN users u ON u.id=p.mentor_id ORDER BY p.id DESC LIMIT 200').all()));
app.get('/api/admin/students', requireAuth, requireRole('admin'), (req,res)=>res.json(q("SELECT u.id,u.name,u.email,u.status,u.created_at,COUNT(p.id) orders,COALESCE(SUM(CASE WHEN p.status='paid' THEN p.amount ELSE 0 END),0) paid_total FROM users u LEFT JOIN purchases p ON p.user_id=u.id WHERE u.role='student' GROUP BY u.id ORDER BY u.id DESC LIMIT 500").all()));
app.get('/api/admin/audit', requireAuth, requireRole('admin'), (req,res)=>res.json(q('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all()));

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Something went wrong. Please try again.'});});
app.listen(PORT,()=>console.log(`PrepOrbit running on port ${PORT}`));
