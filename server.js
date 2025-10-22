const express = require('express');
const path = require('path');
const XLSX = require('xlsx');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);

const app = express();
const PORT = process.env.PORT || 3000;
const saltRounds = 10;

// --- PostgreSQL Database Setup ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// --- Security & Session Setup ---
app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'a-very-strong-secret-key-for-hmc-system',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
        sameSite: 'lax'
    }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Initialize Database Tables ---
const initializeDatabase = async () => {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
        await client.query(`CREATE TABLE IF NOT EXISTS drugs (id SERIAL PRIMARY KEY, drug_code TEXT NOT NULL, drug_name TEXT NOT NULL, barcode TEXT, quantity INTEGER NOT NULL, expiry_date DATE, category TEXT NOT NULL, UNIQUE(drug_code, category), UNIQUE(barcode, category))`);
        await client.query(`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, drug_id INTEGER REFERENCES drugs(id) ON DELETE CASCADE, type TEXT NOT NULL, quantity_change INTEGER NOT NULL, notes TEXT, timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        const passwordCheck = await client.query("SELECT value FROM settings WHERE key = 'admin_password'");
        if (passwordCheck.rows.length === 0) {
            const hash = await bcrypt.hash('12345', saltRounds);
            await client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", ['admin_password', hash]);
            console.log('Default hashed password has been set.');
        }
        console.log('Database tables are ready.');
    } catch (err) {
        console.error('Error initializing database:', err);
    } finally {
        client.release();
    }
};
initializeDatabase();

// --- Auth Endpoints (before protection) ---
app.post('/login', async (req, res) => {
    console.log(">>> Received POST request on /login");
    const { password } = req.body;
    console.log("Login attempt...");
    try {
        const result = await pool.query("SELECT value FROM settings WHERE key = 'admin_password'");
        if (result.rows.length > 0) {
            const hashedPassword = result.rows[0].value;
            console.log("Stored hash found for login attempt.");
            const match = await bcrypt.compare(password, hashedPassword);
            console.log("Password match result:", match);
            if (match) {
                req.session.loggedIn = true;
                console.log("Login successful, attempting to save session...");
                req.session.save(err => {
                    if (err) {
                        console.error('Session save error:', err);
                        return res.status(500).json({ success: false, message: 'Server error during session save.' });
                    }
                    console.log("Session saved successfully. Sending success response.");
                    res.json({ success: true });
                });
                return;
            }
        }
        console.log("Login failed (no user or wrong password), sending failure response.");
        res.status(401).json({ success: false, message: 'Incorrect password.' });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});
app.get('/logout', (req, res) => {
    console.log("Logout request received.");
    req.session.destroy((err) => {
        if(err) { console.error("Logout error:", err); }
        res.clearCookie('connect.sid', { path: '/' });
        console.log("Session destroyed, redirecting to login.");
        res.redirect('/login.html');
    });
});

// --- Auth Middleware ---
const isAuthenticated = (req, res, next) => {
    console.log(`Checking authentication for: ${req.originalUrl}`);
    console.log("Session ID:", req.sessionID);
    console.log("Session loggedIn:", req.session ? req.session.loggedIn : 'No session');
    if (req.session && req.session.loggedIn === true) {
        console.log("Authentication successful, proceeding.");
        return next();
    }
    console.log("Authentication failed.");
    if (req.originalUrl.startsWith('/api')) {
       console.log("API request unauthorized, sending 401.");
       return res.status(401).json({ error: 'Unauthorized - Please log in again.' });
    }
    console.log("Redirecting to login page.");
    res.redirect('/login.html');
};


// --- Static Files & Route Protection ---

// ========== تعديل المسار الرئيسي ==========
// دائماً وجه المسار الرئيسي / إلى صفحة تسجيل الدخول
app.get('/', (req, res) => {
    console.log("Root path '/' requested, redirecting to login.");
    res.redirect('/login.html');
});
// =====================================

// خدمة صفحة تسجيل الدخول وملفاتها الأساسية بدون حماية
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));
// Add other necessary public assets for login page if needed

// حماية بقية الصفحات باستخدام isAuthenticated
app.get('/dashboard.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/categories.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'categories.html')));
app.get('/index.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/settings.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));

// حماية كل الـ APIs
app.use('/api', isAuthenticated);

// خدمة بقية الملفات الثابتة (يأتي بعد تعريف المسارات المحمية)
app.use(express.static(path.join(__dirname)));


// --- API Endpoints ---
app.post('/api/change-password', async (req, res) => { /* ... code ... */ });
app.get('/api/dashboard-stats', async (req, res) => { /* ... code ... */ });
app.get('/api/drugs', async (req, res) => { /* ... code ... */ });
app.post('/api/drugs', async (req, res) => { /* ... code ... */ });
app.post('/api/drugs/withdraw/:id', async (req, res) => { /* ... code ... */ });
app.delete('/api/drugs/:id', async (req, res) => { /* ... code ... */ });
app.put('/api/drugs/:id', async (req, res) => { /* ... code ... */ });
app.get('/api/report', async (req, res) => { /* ... code ... */ });
app.get('/api/transaction-report', async (req, res) => { /* ... code ... */ });

// --- Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err.stack);
    res.status(500).send('Something broke!');
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

