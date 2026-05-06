const express = require('express');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── RATE LIMITING ──
const rateMap = new Map();
function rateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const entry = rateMap.get(ip) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 1; entry.start = now; }
    else entry.count++;
    rateMap.set(ip, entry);
    if (entry.count > maxReq) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}

// ── IN-MEMORY DB ──
const db = { orders: [], visits: [], pageStats: {} };

// ── TELEGRAM ──
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

// ── STATIC FILES WITH CACHING ──
app.use(express.static(__dirname, {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
    else if (/\.(js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));

// ── API: ORDER ──
app.post('/api/order', rateLimit(5, 60000), async (req, res) => {
  const { name, contact, message, items, total, promo } = req.body;
  if (!name || !contact) return res.status(400).json({ error: 'Name and contact required' });

  const order = {
    id: crypto.randomUUID(),
    name: name.trim(), contact: contact.trim(),
    message: (message || '').trim(),
    items: items || [], total: total || 0,
    promo: promo || null, status: 'new',
    createdAt: new Date().toISOString()
  };
  db.orders.push(order);

  const itemsList = Array.isArray(items) && items.length
    ? items.map(i => `  - ${i.name} - ${i.price} shekel`).join('\n')
    : '  (no items)';

  await sendTelegram(
    `NEW ORDER!\n\n` +
    `Name: ${order.name}\n` +
    `Contact: ${order.contact}\n` +
    `Total: ${order.total} shekel\n` +
    (order.promo ? `Promo: ${order.promo}\n` : '') +
    `\nItems:\n${itemsList}\n` +
    (order.message ? `\nMessage: ${order.message}\n` : '') +
    `\nTime: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Jerusalem' })}`
  );

  res.json({ ok: true, orderId: order.id });
});

// ── API: CONTACT FORM ──
app.post('/api/contact', rateLimit(3, 60000), async (req, res) => {
  const { name, contact, message } = req.body;
  if (!name || !contact || !message) return res.status(400).json({ error: 'All fields required' });

  await sendTelegram(
    `NEW MESSAGE!\n\n` +
    `Name: ${name.trim()}\n` +
    `Contact: ${contact.trim()}\n` +
    `Message: ${message.trim()}\n\n` +
    `Time: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Jerusalem' })}`
  );

  res.json({ ok: true });
});

// ── API: TRACK VISIT ──
app.post('/api/visit', (req, res) => {
  const { section, lang } = req.body;
  db.visits.push({ section, lang, timestamp: new Date().toISOString() });
  if (section) db.pageStats[section] = (db.pageStats[section] || 0) + 1;
  if (db.visits.length > 1000) db.visits.shift();
  res.json({ ok: true });
});

// ── ADMIN ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vichi404admin';

app.get('/admin/data', (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_PASSWORD}`) return res.status(401).json({ error: 'Unauthorized' });
  const today = new Date().toDateString();
  const topSections = Object.entries(db.pageStats).sort((a,b) => b[1]-a[1]).slice(0,5).map(([section,count]) => ({ section, count }));
  const langStats = db.visits.reduce((acc, v) => { acc[v.lang] = (acc[v.lang]||0)+1; return acc; }, {});
  res.json({
    orders: db.orders.slice().reverse(),
    stats: {
      totalOrders: db.orders.length,
      ordersToday: db.orders.filter(o => new Date(o.createdAt).toDateString() === today).length,
      totalRevenue: db.orders.reduce((s,o) => s + (Number(o.total)||0), 0),
      totalVisits: db.visits.length,
      visitsToday: db.visits.filter(v => new Date(v.timestamp).toDateString() === today).length,
      topSections, langStats
    }
  });
});

app.post('/admin/order/:id/status', (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_PASSWORD}`) return res.status(401).json({ error: 'Unauthorized' });
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  order.status = req.body.status;
  res.json({ ok: true });
});

app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin - VICHI404</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#e8e8e8;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{background:#111;border:0.5px solid rgba(255,255,255,0.1);padding:48px;max-width:380px;width:90%;border-radius:4px;text-align:center}
h1{font-size:24px;letter-spacing:6px;margin-bottom:8px}p{color:rgba(255,255,255,0.3);font-size:11px;letter-spacing:2px;margin-bottom:32px}
input{width:100%;background:#161616;border:0.5px solid rgba(255,255,255,0.15);color:#fff;padding:14px 16px;border-radius:2px;font-size:14px;outline:none;margin-bottom:16px}
input:focus{border-color:rgba(255,255,255,0.4)}button{width:100%;background:#fff;color:#0a0a0a;border:none;padding:14px;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;cursor:pointer;border-radius:2px;font-weight:600}
.err{color:#ff6b6b;font-size:12px;margin-top:12px;display:none}</style></head>
<body><div class="box"><h1>VICHI404</h1><p>ADMIN PANEL</p>
<input type="password" id="pw" placeholder="Password" onkeydown="if(event.key==='Enter')login()">
<button onclick="login()">Enter →</button>
<div class="err" id="err">Wrong password</div></div>
<script>
function login(){
  const pw=document.getElementById('pw').value;
  fetch('/admin/data',{headers:{'Authorization':'Bearer '+pw}})
    .then(r=>{
      if(r.ok){
        localStorage.setItem('adminpw',pw);
        location.href='/admin/dashboard?pw='+encodeURIComponent(pw);
      } else {
        document.getElementById('err').style.display='block';
      }
    }).catch(()=>document.getElementById('err').style.display='block');
}
const s=localStorage.getItem('adminpw');if(s)document.getElementById('pw').value=s;
</script></body></html>`);
});

app.get('/admin/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard - VICHI404</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#e8e8e8;font-family:'Segoe UI',sans-serif}
nav{background:#111;border-bottom:0.5px solid rgba(255,255,255,0.08);padding:16px 32px;display:flex;justify-content:space-between;align-items:center}
.logo{font-size:16px;letter-spacing:4px;font-weight:600}.logout{background:none;border:0.5px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.4);padding:6px 14px;border-radius:2px;cursor:pointer;font-size:11px}
main{padding:32px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:2px;margin-bottom:2px}
.stat{background:#111;border:0.5px solid rgba(255,255,255,0.07);padding:24px;text-align:center}
.stat-num{font-size:36px;font-weight:700;color:#fff;line-height:1}.stat-label{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-top:8px}
.st{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);margin:24px 0 12px}
.orders{display:flex;flex-direction:column;gap:2px}
.order{background:#111;border:0.5px solid rgba(255,255,255,0.07);padding:20px 24px}
.order-top{display:grid;grid-template-columns:1fr auto auto;gap:16px;align-items:start}
.oname{font-size:14px;font-weight:500}.ocontact{font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px}
.otime{font-size:11px;color:rgba(255,255,255,0.25)}.ototal{font-size:24px;font-weight:700}
.ositems{font-size:12px;color:rgba(255,255,255,0.35);margin-top:12px;padding-top:12px;border-top:0.5px solid rgba(255,255,255,0.06)}
select{background:#161616;border:0.5px solid rgba(255,255,255,0.15);color:#fff;padding:6px 10px;border-radius:2px;font-size:11px;cursor:pointer}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:2px;margin-top:2px}
.chart{background:#111;border:0.5px solid rgba(255,255,255,0.07);padding:24px}
.bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.bl{font-size:12px;color:rgba(255,255,255,0.5);width:100px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt{flex:1;height:3px;background:rgba(255,255,255,0.06);border-radius:2px}
.bf{height:100%;background:rgba(255,255,255,0.7);border-radius:2px}.bc{font-size:11px;color:rgba(255,255,255,0.3);width:28px;text-align:right}
.empty{text-align:center;padding:48px;color:rgba(255,255,255,0.15);font-size:13px;letter-spacing:1px}
@media(max-width:600px){.charts{grid-template-columns:1fr}.order-top{grid-template-columns:1fr auto}}</style></head>
<body><nav><div class="logo">VICHI404 · ADMIN</div><button class="logout" onclick="logout()">Logout</button></nav>
<main id="main"><div class="empty">Loading...</div></main>
<script>
const urlPw = new URLSearchParams(location.search).get('pw');
if(urlPw) localStorage.setItem('adminpw', urlPw);
const pw=localStorage.getItem('adminpw');
if(!pw){location.href='/admin';throw 0;}
// Clean URL
if(urlPw) history.replaceState({},'','/admin/dashboard');
function logout(){localStorage.removeItem('adminpw');location.href='/admin';}
function changeStatus(id,status){
  fetch('/admin/order/'+id+'/status',{method:'POST',headers:{'Authorization':'Bearer '+pw,'Content-Type':'application/json'},body:JSON.stringify({status})}).then(()=>load());
}
function load(){
  fetch('/admin/data',{headers:{'Authorization':'Bearer '+pw}})
    .then(r=>{if(r.status===401){localStorage.removeItem('adminpw');location.href='/admin';}return r.json();})
    .then(render).catch(console.error);
}
function render({orders,stats}){
  const maxS=stats.topSections[0]?.count||1;
  const maxL=Math.max(...Object.values(stats.langStats),1);
  document.getElementById('main').innerHTML=
    '<div class="stats">'+
    '<div class="stat"><div class="stat-num">'+stats.totalOrders+'</div><div class="stat-label">Total Orders</div></div>'+
    '<div class="stat"><div class="stat-num">'+stats.ordersToday+'</div><div class="stat-label">Today</div></div>'+
    '<div class="stat"><div class="stat-num">'+stats.totalRevenue.toLocaleString()+' ₪</div><div class="stat-label">Revenue</div></div>'+
    '<div class="stat"><div class="stat-num">'+stats.totalVisits+'</div><div class="stat-label">Visits</div></div>'+
    '<div class="stat"><div class="stat-num">'+stats.visitsToday+'</div><div class="stat-label">Today Visits</div></div>'+
    '</div>'+
    '<div class="charts">'+
    '<div class="chart"><div class="st" style="margin-top:0">Top Sections</div>'+
    (stats.topSections.length?stats.topSections.map(s=>'<div class="bar-row"><div class="bl">'+s.section+'</div><div class="bt"><div class="bf" style="width:'+Math.round(s.count/maxS*100)+'%"></div></div><div class="bc">'+s.count+'</div></div>').join(''):'<div style="color:rgba(255,255,255,0.2);font-size:12px">No data yet</div>')+
    '</div>'+
    '<div class="chart"><div class="st" style="margin-top:0">Languages</div>'+
    Object.entries(stats.langStats).map(([l,c])=>'<div class="bar-row"><div class="bl">'+l.toUpperCase()+'</div><div class="bt"><div class="bf" style="width:'+Math.round(c/maxL*100)+'%"></div></div><div class="bc">'+c+'</div></div>').join('')+
    '</div></div>'+
    '<div class="st">Orders ('+orders.length+')</div>'+
    '<div class="orders">'+
    (orders.length?orders.map(o=>'<div class="order"><div class="order-top"><div><div class="oname">'+o.name+'</div><div class="ocontact">'+o.contact+'</div><div class="otime">'+new Date(o.createdAt).toLocaleString('ru-RU')+'</div></div><div class="ototal">'+(o.total?o.total+' ₪':'-')+'</div><div><select onchange="changeStatus(\''+o.id+'\',this.value)"><option value="new"'+(o.status==='new'?' selected':'')+'>New</option><option value="done"'+(o.status==='done'?' selected':'')+'>Done</option><option value="cancelled"'+(o.status==='cancelled'?' selected':'')+'>Cancelled</option></select></div></div>'+(Array.isArray(o.items)&&o.items.length?'<div class="ositems">'+o.items.map(i=>i.name||i).join(' · ')+'</div>':'')+(o.message?'<div class="ositems">'+o.message+'</div>':'')+'</div>').join(''):'<div class="empty">No orders yet</div>')+
    '</div>';
}
load();setInterval(load,30000);
</script></body></html>`);
});

// ── 404 ──
app.get('*', (req, res) => {
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`vichi404 running on port ${PORT}`));
