const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ===== CONFIGURATION =====
const OFFICE_LOCATION = {
  lat: 6.5488,
  lng: 3.2695
};

// Admin credentials - CHANGE THIS!
const ADMIN_CREDENTIALS = {
  username: 'admin',
  password: 'nysc2024'
};

// Database path - Use /tmp on Render for free tier
const isRender = process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_URL;
const dbPath = isRender ? '/tmp/attendance.db' : './attendance.db';
console.log(`📁 Database path: ${dbPath}`);

// Initialize database
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');

// Create tables
db.exec(`
  DROP TABLE IF EXISTS members;
  DROP TABLE IF EXISTS queue;
  
  CREATE TABLE members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cds_group TEXT,
    state_code TEXT,
    full_tag TEXT UNIQUE,
    name TEXT,
    phone TEXT,
    status TEXT DEFAULT 'not_checked_in',
    distance REAL,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_tag TEXT,
    queue_number INTEGER,
    status TEXT DEFAULT 'waiting',
    entered_queue DATETIME DEFAULT CURRENT_TIMESTAMP,
    called_at DATETIME,
    completed_at DATETIME
  );
  
  CREATE INDEX IF NOT EXISTS idx_members_tag ON members(full_tag);
  CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
  CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
  CREATE INDEX IF NOT EXISTS idx_queue_number ON queue(queue_number);
`);

console.log('✅ Database initialized with better-sqlite3');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Health check endpoint for Render
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: Date.now() });
});

// Cache for queue
let cachedQueue = [];
let queueCacheTime = 0;
const CACHE_TTL = 2000;

function getNextQueueNumber() {
  const row = db.prepare("SELECT MAX(queue_number) as max_num FROM queue WHERE status IN ('waiting', 'called', 'completed')").get();
  return (row && row.max_num) ? row.max_num + 1 : 1;
}

// ==================== REGISTRATION ====================
app.post('/api/register', (req, res) => {
  const { cds_group, state_code, name, phone } = req.body;
  
  if (!cds_group || !state_code || !name || !phone) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  const full_tag = `${cds_group}, ${state_code}`;
  
  try {
    const existing = db.prepare("SELECT * FROM members WHERE cds_group = ? AND state_code = ?").get(cds_group, state_code);
    if (existing) {
      return res.status(400).json({ error: 'Member already registered' });
    }
    
    db.prepare("INSERT INTO members (cds_group, state_code, full_tag, name, phone) VALUES (?, ?, ?, ?, ?)")
      .run(cds_group, state_code, full_tag, name, phone);
    
    res.json({ success: true, message: 'Registration successful!' });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ==================== LOGIN ====================
app.post('/api/login', (req, res) => {
  const { cds_group, state_code } = req.body;
  
  if (!cds_group || !state_code) {
    return res.status(400).json({ error: 'CDS Group and State Code required' });
  }
  
  try {
    const member = db.prepare("SELECT * FROM members WHERE cds_group = ? AND state_code = ?").get(cds_group, state_code);
    
    if (!member) {
      return res.status(401).json({ error: 'No account found. Please register first.' });
    }
    
    res.json({ 
      success: true, 
      cds_group: member.cds_group,
      state_code: member.state_code,
      full_tag: member.full_tag,
      name: member.name,
      phone: member.phone
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== ADMIN AUTHENTICATION ====================
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
  const token = req.headers['authorization'];
  
  if (!token) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    if (decoded.startsWith('admin:')) {
      next();
    } else {
      res.status(401).json({ error: 'Invalid admin token' });
    }
  } catch (error) {
    res.status(401).json({ error: 'Invalid admin token' });
  }
}

// ==================== PROXIMITY CHECK ====================
app.post('/api/check-proximity', (req, res) => {
  const { cds_group, state_code, latitude, longitude } = req.body;
  
  if (!cds_group || !state_code) {
    return res.status(400).json({ error: 'Missing CDS group or state code' });
  }
  
  const full_tag = `${cds_group}, ${state_code}`;
  const distance = calculateDistance(
    parseFloat(latitude), 
    parseFloat(longitude),
    OFFICE_LOCATION.lat, 
    OFFICE_LOCATION.lng
  );
  
  const isWithinRange = distance <= 100;
  
  // Update member status
  db.prepare("UPDATE members SET status = ?, distance = ?, last_seen = CURRENT_TIMESTAMP WHERE cds_group = ? AND state_code = ?")
    .run(isWithinRange ? 'near_office' : 'not_checked_in', distance, cds_group, state_code);
  
  if (isWithinRange) {
    const existing = db.prepare("SELECT * FROM queue WHERE full_tag = ? AND status IN ('waiting', 'called')").get(full_tag);
    
    if (!existing) {
      const queueNumber = getNextQueueNumber();
      db.prepare("INSERT INTO queue (full_tag, queue_number) VALUES (?, ?)").run(full_tag, queueNumber);
      updateQueueStatus();
    }
  }
  
  res.json({ 
    within_range: isWithinRange, 
    distance: Math.round(distance),
    in_queue: isWithinRange
  });
});

// ==================== QUEUE ENDPOINTS ====================
app.get('/api/queue', (req, res) => {
  const now = Date.now();
  if (cachedQueue.length > 0 && (now - queueCacheTime) < CACHE_TTL) {
    return res.json(cachedQueue);
  }
  
  const rows = db.prepare(`
    SELECT q.*, m.name, m.cds_group, m.state_code 
    FROM queue q 
    JOIN members m ON q.full_tag = m.full_tag 
    WHERE q.status IN ('waiting', 'called')
    ORDER BY q.queue_number ASC
  `).all();
  
  cachedQueue = rows;
  queueCacheTime = now;
  res.json(rows);
});

app.post('/api/call-next', authenticateAdmin, (req, res) => {
  const row = db.prepare(`
    SELECT * FROM queue 
    WHERE status = 'waiting' 
    ORDER BY queue_number ASC 
    LIMIT 1
  `).get();
  
  if (row) {
    db.prepare("UPDATE queue SET status = 'called', called_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
    
    io.emit('your-turn', { full_tag: row.full_tag, queue_number: row.queue_number });
    updateQueueStatus();
    res.json({ success: true, called_tag: row.full_tag, queue_number: row.queue_number });
  } else {
    res.json({ success: false, message: "No one in queue" });
  }
});

app.post('/api/complete-checkin', (req, res) => {
  const { full_tag } = req.body;
  
  if (!full_tag) return res.status(400).json({ error: 'Full tag required' });
  
  db.prepare("UPDATE queue SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE full_tag = ? AND status = 'called'").run(full_tag);
  db.prepare("UPDATE members SET status = 'checked_in' WHERE full_tag = ?").run(full_tag);
  
  updateQueueStatus();
  res.json({ success: true });
});

// ==================== PUBLIC ENDPOINTS ====================
app.get('/api/members', (req, res) => {
  const rows = db.prepare("SELECT cds_group, state_code, full_tag, name, phone, status, registered_at FROM members ORDER BY registered_at DESC LIMIT 100").all();
  res.json(rows);
});

app.get('/api/stats', (req, res) => {
  const total = db.prepare("SELECT COUNT(*) as total FROM members").get();
  const waiting = db.prepare("SELECT COUNT(*) as waiting FROM queue WHERE status = 'waiting'").get();
  
  res.json({
    total_members: total.total,
    waiting_in_queue: waiting.waiting,
    server_status: 'healthy'
  });
});

// ==================== HELPER FUNCTIONS ====================
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function updateQueueStatus() {
  const rows = db.prepare(`
    SELECT q.*, m.name, m.cds_group, m.state_code 
    FROM queue q 
    JOIN members m ON q.full_tag = m.full_tag 
    WHERE q.status IN ('waiting', 'called')
    ORDER BY q.queue_number ASC
  `).all();
  
  cachedQueue = rows;
  queueCacheTime = Date.now();
  io.emit('queue-update', rows);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ CDS Attendance System Running!`);
  console.log(`📍 Server: http://0.0.0.0:${PORT}`);
  console.log(`💾 Database: ${dbPath}`);
  console.log(`📏 Range: 100 METERS`);
  console.log(`\n🔐 Admin Login: ${ADMIN_CREDENTIALS.username} / ${ADMIN_CREDENTIALS.password}\n`);
});