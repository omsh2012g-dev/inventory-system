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
const initializeDatabase = async () => { /* ... code ... */ };
initializeDatabase();

// --- Auth Endpoints ---
// ========== تعديل نقطة النهاية /login ==========
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
                // بدلاً من regenerate، قم بتحديث الجلسة الحالية مباشرة
                req.session.loggedIn = true;
                console.log("Login successful, session updated, attempting to save...");
                // Explicitly save the updated session
                req.session.save(err => {
                    if (err) {
                        console.error('Session save error after login:', err);
                        return res.status(500).json({ success: false, message: 'Server error saving session.' });
                    }
                    console.log("Session saved successfully after login update. Sending success response.");
                    res.json({ success: true });
                });
                return; // Prevent fall-through
            }
        }
        console.log("Login failed (no user or wrong password), sending failure response.");
        res.status(401).json({ success: false, message: 'Incorrect password.' });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});
// ===========================================
app.get('/logout', (req, res) => { /* ... code ... */ });

// --- Auth Middleware ---
const isAuthenticated = (req, res, next) => { /* ... code ... */ };

// --- Static Files & Route Protection ---
// ... (code remains the same)

// --- API Endpoints ---
// ... (all other API endpoints remain the same)

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

