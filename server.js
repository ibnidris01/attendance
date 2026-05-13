const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const initSqlJs = require('sql.js');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

// ===== CONFIGURATION =====
const OFFICE_LOCATION = { lat: 6.5488, lng: 3.2695 };
const ADMIN_CREDENTIALS = { username: 'admin', password: 'nysc2024' };
const isRender = process.env.RENDER === 'true';
const dbPath = isRender ? '/tmp/attendance.db' : './attendance.db';

let db;

// Initialize database
async function initDatabase() {
  const SQL = await initSqlJs();
  
  try {
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
      console.log('📁 Existing database loaded');
    } else {
      db = new SQL.Database();
      console.log('📁 New database created');
    }
  } catch (err) {
    console.log('Creating new database...');
    db = new SQL.Database();
  }
  
  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cds_group TEXT,
      state_code TEXT,
      full_tag TEXT UNIQUE,
      name TEXT,
      phone TEXT,
      status TEXT DEFAULT 'not_checked_in',
      distance REAL,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_tag TEXT,
      queue_number INTEGER,
      status TEXT DEFAULT 'waiting',
      entered_queue DATETIME DEFAULT CURRENT_TIMESTAMP,
      called_at DATETIME
    )
  `);
  
  saveDatabase();
  console.log('✅ Database ready');
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

function query(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  } catch (err) {
    console.error('Query error:', err);
    return [];
  }
}

function run(sql, params = []) {
  try {
    db.run(sql, params);
    saveDatabase();
    return true;
  } catch (err) {
    console.error('Run error:', err);
    return false;
  }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Health check
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ==================== API ENDPOINTS ====================

// Register
app.post('/api/register', (req, res) => {
  const { cds_group, state_code, name, phone } = req.body;
  const full_tag = `${cds_group}, ${state_code}`;
  
  const existing = query('SELECT * FROM members WHERE cds_group = ? AND state_code = ?', [cds_group, state_code]);
  if (existing.length > 0) {
    return res.status(400).json({ error: 'Member already registered' });
  }
  
  const success = run(
    'INSERT INTO members (cds_group, state_code, full_tag, name, phone) VALUES (?, ?, ?, ?, ?)',
    [cds_group, state_code, full_tag, name, phone]
  );
  
  if (success) {
    res.json({ success: true, message: 'Registration successful!' });
  } else {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', (req, res) => {
  const { cds_group, state_code } = req.body;
  
  const members = query('SELECT * FROM members WHERE cds_group = ? AND state_code = ?', [cds_group, state_code]);
  
  if (members.length === 0) {
    return res.status(401).json({ error: 'No account found. Please register first.' });
  }
  
  const member = members[0];
  res.json({
    success: true,
    cds_group: member.cds_group,
    state_code: member.state_code,
    full_tag: member.full_tag,
    name: member.name,
    phone: member.phone
  });
});

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
    const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
    res.json({ success: true, token: token });
  } else {
    res.status(401).json({ success: false, error: 'Invalid admin credentials' });
  }
});

function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}

// Proximity check
app.post('/api/check-proximity', (req, res) => {
  const { cds_group, state_code, latitude, longitude } = req.body;
  const full_tag = `${cds_group}, ${state_code}`;
  
  // Calculate distance in meters
  const R = 6371e3;
  const φ1 = latitude * Math.PI/180;
  const φ2 = OFFICE_LOCATION.lat * Math.PI/180;
  const Δφ = (OFFICE_LOCATION.lat - latitude) * Math.PI/180;
  const Δλ = (OFFICE_LOCATION.lng - longitude) * Math.PI/180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;
  
  const isWithinRange = distance <= 100;
  
  run(
    "UPDATE members SET status = ?, distance = ?, last_seen = CURRENT_TIMESTAMP WHERE cds_group = ? AND state_code = ?",
    [isWithinRange ? 'near_office' : 'not_checked_in', distance, cds_group, state_code]
  );
  
  if (isWithinRange) {
    const inQueue = query('SELECT * FROM queue WHERE full_tag = ? AND status IN ("waiting", "called")', [full_tag]);
    if (inQueue.length === 0) {
      const maxResult = query('SELECT MAX(queue_number) as max_num FROM queue');
      const nextNumber = (maxResult[0]?.max_num || 0) + 1;
      
      run('INSERT INTO queue (full_tag, queue_number) VALUES (?, ?)', [full_tag, nextNumber]);
      updateQueueStatus();
    }
  }
  
  res.json({
    within_range: isWithinRange,
    distance: Math.round(distance),
    in_queue: isWithinRange
  });
});

// Get queue
app.get('/api/queue', (req, res) => {
  const queue = query('SELECT * FROM queue WHERE status IN ("waiting", "called") ORDER BY queue_number ASC');
  res.json(queue);
});

// Call next (admin only)
app.post('/api/call-next', authenticateAdmin, (req, res) => {
  const next = query('SELECT * FROM queue WHERE status = "waiting" ORDER BY queue_number ASC LIMIT 1');
  
  if (next.length > 0) {
    run('UPDATE queue SET status = "called", called_at = CURRENT_TIMESTAMP WHERE id = ?', [next[0].id]);
    io.emit('your-turn', { full_tag: next[0].full_tag, queue_number: next[0].queue_number });
    updateQueueStatus();
    res.json({ success: true, called_tag: next[0].full_tag, queue_number: next[0].queue_number });
  } else {
    res.json({ success: false, message: "No one in queue" });
  }
});

// Complete check-in
app.post('/api/complete-checkin', (req, res) => {
  const { full_tag } = req.body;
  
  run('UPDATE queue SET status = "completed", completed_at = CURRENT_TIMESTAMP WHERE full_tag = ? AND status = "called"', [full_tag]);
  run('UPDATE members SET status = "checked_in" WHERE full_tag = ?', [full_tag]);
  updateQueueStatus();
  res.json({ success: true });
});

// Get members
app.get('/api/members', (req, res) => {
  const members = query('SELECT cds_group, state_code, full_tag, name, phone, status, registered_at FROM members ORDER BY registered_at DESC LIMIT 100');
  res.json(members);
});

// Get stats
app.get('/api/stats', (req, res) => {
  const total = query('SELECT COUNT(*) as total FROM members');
  const waiting = query('SELECT COUNT(*) as waiting FROM queue WHERE status = "waiting"');
  res.json({
    total_members: total[0]?.total || 0,
    waiting_in_queue: waiting[0]?.waiting || 0,
    server_status: 'healthy'
  });
});

function updateQueueStatus() {
  const queue = query('SELECT * FROM queue WHERE status IN ("waiting", "called") ORDER BY queue_number ASC');
  io.emit('queue-update', queue);
}

// Start server
initDatabase().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ NYSC CDS Attendance System Running!`);
    console.log(`📍 Server: http://0.0.0.0:${PORT}`);
    console.log(`💾 Database: ${dbPath}`);
    console.log(`📏 Range: 100 METERS`);
    console.log(`\n🔐 Admin Login: ${ADMIN_CREDENTIALS.username} / ${ADMIN_CREDENTIALS.password}\n`);
  });
});