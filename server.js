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

// --- Security & Session Setup (Using PostgreSQL for session store) ---
// Initialize session middleware FIRST
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
// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Initialize Database Tables ---
const initializeDatabase = async () => { /* ... code remains the same ... */ };
initializeDatabase();

// --- Auth Endpoints (comes after session middleware) ---
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
                // Regenerate session for security upon login
                req.session.regenerate(function(err) {
                    if (err) {
                       console.error('Session regeneration error:', err);
                       return res.status(500).json({ success: false, message: 'Server error during login.' });
                    }
                    // Store user state in session
                    req.session.loggedIn = true;
                    console.log("Login successful, session created/regenerated. Sending success response.");
                    res.json({ success: true });
                });
                return; // Prevent further execution until regeneration completes
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
        if(err) {
            console.error("Logout error:", err);
            // Even if destroy fails, try to clear cookie and redirect
        }
        res.clearCookie('connect.sid', { path: '/' }); // Ensure cookie is cleared for the root path
        console.log("Session destroyed, redirecting to login.");
        res.redirect('/login.html');
    });
});

// --- Auth Middleware (More detailed logging) ---
const isAuthenticated = (req, res, next) => {
    console.log(`Checking authentication for: ${req.originalUrl}`);
    console.log("Session ID:", req.sessionID);
    console.log("Session loggedIn:", req.session ? req.session.loggedIn : 'No session');
    // Check if session exists AND if loggedIn is true
    if (req.session && req.session.loggedIn === true) {
        console.log("Authentication successful, proceeding.");
        return next(); // User is authenticated
    }
    // User is not authenticated
    console.log("Authentication failed.");
    // If it's an API request, send 401
    if (req.originalUrl.startsWith('/api')) {
       console.log("API request unauthorized, sending 401.");
       return res.status(401).json({ error: 'Unauthorized - Please log in again.' });
    }
    // Otherwise, redirect to login page
    console.log("Redirecting to login page.");
    res.redirect('/login.html');
};


// --- Static Files & Route Protection (Revised Order) ---

// 1. Serve absolutely essential public files FIRST (e.g., CSS for login)
// Allows login page to render correctly before auth checks on other routes.
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
// Serve logo if needed on login page
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));
// Serve Toastify JS for login error messages potentially (if used there)
app.get('/node_modules/toastify-js/src/toastify.css', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/toastify-js/src/toastify.css')));
app.get('/node_modules/toastify-js/src/toastify.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/toastify-js/src/toastify.js')));


// 2. Protect all other HTML routes AND API routes
app.get('/', isAuthenticated, (req, res) => res.redirect('/dashboard.html')); // Redirect root after login
app.get('/dashboard.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/categories.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'categories.html')));
app.get('/index.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/settings.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));
app.use('/api', isAuthenticated); // Protect all API routes

// 3. Serve remaining static files AFTER protection checks
// (This handles dashboard.js, settings.js, icons, etc.)
app.use(express.static(path.join(__dirname)));


// --- API Endpoints ---
app.post('/api/change-password', async (req, res) => { /* ... code remains the same ... */ });
app.get('/api/dashboard-stats', async (req, res) => { /* ... code remains the same ... */ });
app.get('/api/drugs', async (req, res) => { /* ... code remains the same ... */ });
app.post('/api/drugs', async (req, res) => { /* ... code remains the same ... */ });
app.post('/api/drugs/withdraw/:id', async (req, res) => { /* ... code remains the same ... */ });
app.delete('/api/drugs/:id', async (req, res) => { /* ... code remains the same ... */ });
app.put('/api/drugs/:id', async (req, res) => { /* ... code remains the same ... */ });
app.get('/api/report', async (req, res) => { /* ... code remains the same ... */ });
app.get('/api/transaction-report', async (req, res) => { /* ... code remains the same ... */ });

// --- Error Handling Middleware (Optional but good practice) ---
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err.stack);
    res.status(500).send('Something broke!');
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

