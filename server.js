const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6
});

// ===== CONFIGURATION =====
// const OFFICE_LOCATION = {
//   lat: 6.5488,
//   lng: 3.2695
// };

const OFFICE_LOCATION = {
  lat: 6.5488,   // Your office latitude
  lng: 3.2695    // Your office longitude
};

// Admin credentials - CHANGE THIS PASSWORD!
const ADMIN_CREDENTIALS = {
  username: 'admin',
  password: 'nysc2024'  // CHANGE THIS FOR SECURITY!
};

// Enable WAL mode for better concurrency
const db = new sqlite3.Database('./attendance.db');
db.run("PRAGMA journal_mode=WAL");
db.run("PRAGMA synchronous=NORMAL");
db.run("PRAGMA cache_size=-64000");
db.run("PRAGMA temp_store=MEMORY");
db.configure("busyTimeout", 10000);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Rate limiting
const rateLimit = new Map();
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 60000;
  const maxRequests = 60;
  
  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, { count: 1, resetTime: now + windowMs });
    return next();
  }
  
  const record = rateLimit.get(ip);
  if (now > record.resetTime) {
    rateLimit.set(ip, { count: 1, resetTime: now + windowMs });
    return next();
  }
  
  if (record.count >= maxRequests) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  record.count++;
  next();
});

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimit) {
    if (now > record.resetTime) {
      rateLimit.delete(ip);
    }
  }
}, 60000);

// Database setup
db.serialize(() => {
  db.run("DROP TABLE IF EXISTS members");
  db.run("DROP TABLE IF EXISTS queue");
  
  db.run(`
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
    )
  `);
  
  db.run(`
    CREATE TABLE queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_tag TEXT,
      queue_number INTEGER,
      status TEXT DEFAULT 'waiting',
      entered_queue DATETIME DEFAULT CURRENT_TIMESTAMP,
      called_at DATETIME,
      completed_at DATETIME
    )
  `);
  
  db.run("CREATE INDEX idx_members_tag ON members(full_tag)");
  db.run("CREATE INDEX idx_members_status ON members(status)");
  db.run("CREATE INDEX idx_queue_status ON queue(status)");
  db.run("CREATE INDEX idx_queue_number ON queue(queue_number)");
  
  console.log('✅ Database optimized with WAL mode and indexes');
});

// Cache
let cachedQueue = [];
let queueCacheTime = 0;
const CACHE_TTL = 2000;

function getCachedQueue(callback) {
  const now = Date.now();
  if (cachedQueue.length > 0 && (now - queueCacheTime) < CACHE_TTL) {
    callback(null, cachedQueue);
    return true;
  }
  return false;
}

function updateCache(queue) {
  cachedQueue = queue;
  queueCacheTime = Date.now();
}

function getNextQueueNumber(callback) {
  db.get("SELECT MAX(queue_number) as max_num FROM queue WHERE status IN ('waiting', 'called', 'completed')", (err, row) => {
    const nextNumber = (row && row.max_num) ? row.max_num + 1 : 1;
    callback(nextNumber);
  });
}

// ==================== REGISTRATION ====================
app.post('/api/register', (req, res) => {
  const { cds_group, state_code, name, phone } = req.body;
  
  if (!cds_group || !state_code || !name || !phone) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  const full_tag = `${cds_group}, ${state_code}`;
  
  db.get(
    "SELECT * FROM members WHERE cds_group = ? AND state_code = ?",
    [cds_group, state_code],
    (err, existingMember) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existingMember) {
        return res.status(400).json({ error: 'Member already registered' });
      }
      
      db.run(
        "INSERT INTO members (cds_group, state_code, full_tag, name, phone) VALUES (?, ?, ?, ?, ?)",
        [cds_group, state_code, full_tag, name, phone],
        function(err) {
          if (err) return res.status(400).json({ error: err.message });
          res.json({ success: true, message: 'Registration successful!' });
        }
      );
    }
  );
});

// ==================== LOGIN ====================
app.post('/api/login', (req, res) => {
  const { cds_group, state_code } = req.body;
  
  if (!cds_group || !state_code) {
    return res.status(400).json({ error: 'CDS Group and State Code required' });
  }
  
  db.get(
    "SELECT * FROM members WHERE cds_group = ? AND state_code = ?",
    [cds_group, state_code],
    (err, member) => {
      if (err) return res.status(500).json({ error: err.message });
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
    }
  );
});

// ==================== ADMIN AUTHENTICATION ====================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  
  console.log('🔐 Admin login attempt:', { username });
  
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
  
  db.run(
    "UPDATE members SET status = ?, distance = ?, last_seen = CURRENT_TIMESTAMP WHERE cds_group = ? AND state_code = ?",
    [isWithinRange ? 'near_office' : 'not_checked_in', distance, cds_group, state_code]
  );
  
  if (isWithinRange) {
    db.get(
      "SELECT * FROM queue WHERE full_tag = ? AND status IN ('waiting', 'called')",
      [full_tag],
      (err, row) => {
        if (!row) {
          getNextQueueNumber((queueNumber) => {
            db.run(
              "INSERT INTO queue (full_tag, queue_number) VALUES (?, ?)",
              [full_tag, queueNumber],
              () => {
                updateQueueStatus();
              }
            );
          });
        }
      }
    );
  }
  
  res.json({ 
    within_range: isWithinRange, 
    distance: Math.round(distance),
    in_queue: isWithinRange
  });
});

// ==================== QUEUE ENDPOINTS ====================
app.get('/api/queue', (req, res) => {
  if (getCachedQueue((err, cached) => {
    res.json(cached);
  })) return;
  
  db.all(`
    SELECT q.*, m.name, m.cds_group, m.state_code 
    FROM queue q 
    JOIN members m ON q.full_tag = m.full_tag 
    WHERE q.status IN ('waiting', 'called')
    ORDER BY q.queue_number ASC
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      updateCache(rows || []);
      res.json(rows || []);
    }
  });
});

app.post('/api/call-next', authenticateAdmin, (req, res) => {
  db.get(`
    SELECT * FROM queue 
    WHERE status = 'waiting' 
    ORDER BY queue_number ASC 
    LIMIT 1
  `, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (row) {
      db.run(
        "UPDATE queue SET status = 'called', called_at = CURRENT_TIMESTAMP WHERE id = ?",
        [row.id],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          
          io.emit('your-turn', { full_tag: row.full_tag, queue_number: row.queue_number });
          updateQueueStatus();
          res.json({ success: true, called_tag: row.full_tag, queue_number: row.queue_number });
        }
      );
    } else {
      res.json({ success: false, message: "No one in queue" });
    }
  });
});

app.post('/api/complete-checkin', (req, res) => {
  const { full_tag } = req.body;
  
  if (!full_tag) return res.status(400).json({ error: 'Full tag required' });
  
  db.run(
    "UPDATE queue SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE full_tag = ? AND status = 'called'",
    [full_tag],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      
      db.run("UPDATE members SET status = 'checked_in' WHERE full_tag = ?", [full_tag]);
      updateQueueStatus();
      res.json({ success: true });
    }
  );
});

// ==================== PUBLIC ENDPOINTS ====================
app.get('/api/members', (req, res) => {
  db.all("SELECT cds_group, state_code, full_tag, name, phone, status, registered_at FROM members ORDER BY registered_at DESC LIMIT 100", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/stats', (req, res) => {
  db.get("SELECT COUNT(*) as total FROM members", (err, members) => {
    db.get("SELECT COUNT(*) as waiting FROM queue WHERE status = 'waiting'", (err2, queue) => {
      res.json({
        total_members: members ? members.total : 0,
        waiting_in_queue: queue ? queue.waiting : 0,
        server_status: 'healthy'
      });
    });
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
  db.all(`
    SELECT q.*, m.name, m.cds_group, m.state_code 
    FROM queue q 
    JOIN members m ON q.full_tag = m.full_tag 
    WHERE q.status IN ('waiting', 'called')
    ORDER BY q.queue_number ASC
  `, (err, rows) => {
    if (!err) {
      updateCache(rows || []);
      io.emit('queue-update', rows || []);
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ CDS Attendance System Running (Optimized for 3,000+ users)!`);
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`👥 Member Portal: http://localhost:${PORT}`);
  console.log(`👨‍💼 Admin Panel: http://localhost:${PORT}/admin.html`);
  console.log(`📊 WAL Mode: ENABLED`);
  console.log(`💾 Cache TTL: ${CACHE_TTL}ms`);
  console.log(`📏 Range: 100 METERS`);
  console.log(`\n🔐 Admin Login:`);
  console.log(`   Username: ${ADMIN_CREDENTIALS.username}`);
  console.log(`   Password: ${ADMIN_CREDENTIALS.password}`);
  console.log(`\n⚠️  CHANGE THE DEFAULT ADMIN PASSWORD FOR SECURITY!\n`);
});