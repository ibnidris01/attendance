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
// const OFFICE_LOCATION = { lat: 6.550223, lng: 3.269505  };
const OFFICE_LOCATION = { lat: 6.550223, lng: 3.269505  };
const ADMIN_CREDENTIALS = { username: 'admin', password: 'nysc2024' };
const isRender = process.env.RENDER === 'true';
const dbPath = isRender ? '/tmp/attendance.db' : './attendance.db';
const INACTIVE_TIMEOUT = 30000; // 30 seconds - remove from queue if inactive

let db;
let activeUsers = new Map(); // Track user locations and last seen

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
      status TEXT DEFAULT 'registered',
      distance REAL,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
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
  
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT,
      type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read BOOLEAN DEFAULT 0
    )
  `);
  
  saveDatabase();
  console.log('✅ Database ready');
  
  // Start cleanup interval (runs every 10 seconds)
  setInterval(cleanupInactiveUsers, 10000);
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

// Remove inactive users from queue
function cleanupInactiveUsers() {
  const now = Date.now();
  let removed = false;
  
  for (const [full_tag, data] of activeUsers) {
    if (now - data.lastSeen > INACTIVE_TIMEOUT) {
      const inQueue = query('SELECT * FROM queue WHERE full_tag = ? AND status = "waiting"', [full_tag]);
      if (inQueue.length > 0) {
        run('DELETE FROM queue WHERE full_tag = ? AND status = "waiting"', [full_tag]);
        console.log(`🗑️ Removed inactive user from queue: ${full_tag}`);
        removed = true;
        run('UPDATE members SET status = "left_range" WHERE full_tag = ?', [full_tag]);
        
        // Broadcast to all members
        io.emit('system-notification', {
          message: `${full_tag} has been removed from queue due to inactivity`,
          type: 'warning'
        });
      }
      activeUsers.delete(full_tag);
    }
  }
  
  if (removed) {
    reorganizeQueueNumbers();
    updateQueueStatus();
  }
}

// Reorganize queue numbers to be sequential
function reorganizeQueueNumbers() {
  const queue = query('SELECT id FROM queue WHERE status = "waiting" ORDER BY queue_number ASC');
  let newNumber = 1;
  for (const item of queue) {
    run('UPDATE queue SET queue_number = ? WHERE id = ?', [newNumber, item.id]);
    newNumber++;
  }
}

function getNextQueueNumber() {
  const maxResult = query('SELECT MAX(queue_number) as max_num FROM queue');
  return (maxResult[0]?.max_num || 0) + 1;
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Health check
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ==================== API ENDPOINTS ====================

// Register - User creates account (stays forever)
app.post('/api/register', (req, res) => {
  const { cds_group, state_code, name, phone } = req.body;
  const full_tag = `${cds_group}, ${state_code}`;
  
  const existing = query('SELECT * FROM members WHERE cds_group = ? AND state_code = ?', [cds_group, state_code]);
  if (existing.length > 0) {
    return res.status(400).json({ error: 'Member already registered. Please login.' });
  }
  
  const success = run(
    'INSERT INTO members (cds_group, state_code, full_tag, name, phone, status) VALUES (?, ?, ?, ?, ?, ?)',
    [cds_group, state_code, full_tag, name, phone, 'registered']
  );
  
  if (success) {
    // Broadcast new member notification
    io.emit('system-notification', {
      message: `🎉 New member registered: ${name} (${cds_group})`,
      type: 'info'
    });
    res.json({ success: true, message: 'Registration successful! You can now login.' });
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
    phone: member.phone,
    status: member.status
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

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2 - lat1) * Math.PI/180;
  const Δλ = (lon2 - lon1) * Math.PI/180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Proximity check
app.post('/api/check-proximity', (req, res) => {
  const { cds_group, state_code, latitude, longitude } = req.body;
  const full_tag = `${cds_group}, ${state_code}`;
  
  const distance = calculateDistance(latitude, longitude, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
  const isWithinRange = distance <= 100;
  
  activeUsers.set(full_tag, {
    lastSeen: Date.now(),
    latitude,
    longitude,
    distance
  });
  
  const newStatus = isWithinRange ? 'near_office' : 'away';
  run(
    "UPDATE members SET status = ?, distance = ?, last_seen = CURRENT_TIMESTAMP WHERE cds_group = ? AND state_code = ?",
    [newStatus, distance, cds_group, state_code]
  );
  
  let wasAdded = false;
  if (isWithinRange) {
    const inQueue = query('SELECT * FROM queue WHERE full_tag = ? AND status IN ("waiting", "called")', [full_tag]);
    
    if (inQueue.length === 0) {
      const queueNumber = getNextQueueNumber();
      run('INSERT INTO queue (full_tag, queue_number, status) VALUES (?, ?, ?)', [full_tag, queueNumber, 'waiting']);
      console.log(`➕ Added to queue: ${full_tag} (Queue #${queueNumber})`);
      wasAdded = true;
      
      // Broadcast to all members that someone joined the queue
      io.emit('system-notification', {
        message: `📌 ${full_tag} has joined the queue at position #${queueNumber}`,
        type: 'queue_join'
      });
      
      reorganizeQueueNumbers();
      updateQueueStatus();
    }
  } else {
    const inQueue = query('SELECT * FROM queue WHERE full_tag = ? AND status = "waiting"', [full_tag]);
    if (inQueue.length > 0) {
      const queueNum = inQueue[0].queue_number;
      run('DELETE FROM queue WHERE full_tag = ? AND status = "waiting"', [full_tag]);
      console.log(`🗑️ Removed from queue (left range): ${full_tag}`);
      
      // Broadcast to all members
      io.emit('system-notification', {
        message: `🚶 ${full_tag} has left the area and was removed from position #${queueNum}`,
        type: 'queue_leave'
      });
      
      reorganizeQueueNumbers();
      updateQueueStatus();
    }
  }
  
  let queuePosition = null;
  const currentQueue = query('SELECT queue_number FROM queue WHERE full_tag = ? AND status = "waiting"', [full_tag]);
  if (currentQueue.length > 0) {
    queuePosition = currentQueue[0].queue_number;
  }
  
  res.json({
    within_range: isWithinRange,
    distance: Math.round(distance),
    in_queue: currentQueue.length > 0,
    queue_position: queuePosition,
    just_added: wasAdded
  });
});

// Get queue
app.get('/api/queue', (req, res) => {
  const queue = query('SELECT q.*, m.name, m.cds_group, m.state_code FROM queue q JOIN members m ON q.full_tag = m.full_tag WHERE q.status IN ("waiting", "called") ORDER BY q.queue_number ASC');
  res.json(queue);
});

// Call next (admin only) - WITH BROADCAST NOTIFICATION
app.post('/api/call-next', authenticateAdmin, (req, res) => {
  const next = query('SELECT * FROM queue WHERE status = "waiting" ORDER BY queue_number ASC LIMIT 1');
  
  if (next.length > 0) {
    const calledUser = next[0];
    run('UPDATE queue SET status = "called", called_at = CURRENT_TIMESTAMP WHERE id = ?', [calledUser.id]);
    
    // Get user details for notification
    const userDetails = query('SELECT name, cds_group FROM members WHERE full_tag = ?', [calledUser.full_tag]);
    const userName = userDetails.length > 0 ? userDetails[0].name : calledUser.full_tag;
    
    // Send turn notification to the specific user
    io.emit('your-turn', { 
      full_tag: calledUser.full_tag, 
      queue_number: calledUser.queue_number,
      name: userName
    });
    
    // BROADCAST TO ALL MEMBERS - notify everyone who was called
    io.emit('member-called', {
      queue_number: calledUser.queue_number,
      name: userName,
      cds_group: userDetails.length > 0 ? userDetails[0].cds_group : '',
      full_tag: calledUser.full_tag,
      timestamp: new Date().toLocaleTimeString()
    });
    
    // System notification for all members
    io.emit('system-notification', {
      message: `🔔 Attention: #${calledUser.queue_number} - ${userName} has been called to the CDS office`,
      type: 'call_alert'
    });
    
    updateQueueStatus();
    res.json({ success: true, called_tag: calledUser.full_tag, queue_number: calledUser.queue_number });
  } else {
    res.json({ success: false, message: "No one in queue" });
  }
});

// Complete check-in
app.post('/api/complete-checkin', (req, res) => {
  const { full_tag } = req.body;
  
  // Get user details before removal
  const userDetails = query('SELECT name, queue_number FROM members m JOIN queue q ON m.full_tag = q.full_tag WHERE m.full_tag = ? AND q.status = "called"', [full_tag]);
  
  run('UPDATE queue SET status = "completed", completed_at = CURRENT_TIMESTAMP WHERE full_tag = ? AND status = "called"', [full_tag]);
  run('UPDATE members SET status = "checked_in" WHERE full_tag = ?', [full_tag]);
  
  activeUsers.delete(full_tag);
  
  // Broadcast check-in notification
  if (userDetails.length > 0) {
    io.emit('system-notification', {
      message: `✅ ${userDetails[0].name} has successfully checked in`,
      type: 'success'
    });
  }
  
  reorganizeQueueNumbers();
  updateQueueStatus();
  res.json({ success: true });
});

// Get members
app.get('/api/members', (req, res) => {
  const members = query('SELECT cds_group, state_code, full_tag, name, phone, status, distance, registered_at, last_seen FROM members ORDER BY registered_at DESC');
  res.json(members);
});

// Get stats
app.get('/api/stats', (req, res) => {
  const total = query('SELECT COUNT(*) as total FROM members');
  const waiting = query('SELECT COUNT(*) as waiting FROM queue WHERE status = "waiting"');
  const near = query('SELECT COUNT(*) as near FROM members WHERE status = "near_office"');
  res.json({
    total_members: total[0]?.total || 0,
    waiting_in_queue: waiting[0]?.waiting || 0,
    near_office: near[0]?.near || 0,
    server_status: 'healthy'
  });
});

function updateQueueStatus() {
  const queue = query('SELECT q.*, m.name, m.cds_group, m.state_code FROM queue q JOIN members m ON q.full_tag = m.full_tag WHERE q.status IN ("waiting", "called") ORDER BY q.queue_number ASC');
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
    console.log(`⏱️ Inactive timeout: ${INACTIVE_TIMEOUT/1000} seconds`);
    console.log(`📢 Notifications: ENABLED`);
    console.log(`\n🔐 Admin Login: ${ADMIN_CREDENTIALS.username} / ${ADMIN_CREDENTIALS.password}\n`);
  });
});