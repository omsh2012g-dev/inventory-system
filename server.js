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

// --- Confide in Proxy ---
// Tell Express that it's behind a proxy (like Render) and to trust the first proxy
app.set('trust proxy', 1); // Important for secure cookies and session management behind proxies

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
        secure: process.env.NODE_ENV === 'production', // Should be true on Render (HTTPS)
        httpOnly: true, // Prevent client-side JS access
        maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
        sameSite: 'lax', // Good balance of security and usability
        path: '/' // Explicitly set the path
    }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Initialize Database Tables ---
const initializeDatabase = async () => { /* ... code ... */ };
initializeDatabase();

// --- Auth Endpoints ---
app.post('/login', async (req, res) => {
    console.log(">>> Received POST request on /login (Trust Proxy Version)");
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
                // Update the current session directly
                req.session.loggedIn = true;
                console.log("Login successful, session updated, attempting to save...");
                req.session.save(err => {
                    if (err) {
                        console.error('Session save error after login update:', err);
                        return res.status(500).json({ success: false, message: 'Server error saving session.' });
                    }
                    console.log("Session saved successfully after login update. Sending success response.");
                    // Ensure cookie is set before sending response if possible, though save handles it
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
app.get('/logout', (req, res) => { /* ... code ... */ });

// --- Auth Middleware ---
const isAuthenticated = (req, res, next) => {
    console.log(`Checking authentication for: ${req.originalUrl}`);
    console.log("Session ID received:", req.sessionID);
    console.log("Session exists:", !!req.session); // Check if session object exists
    console.log("Session loggedIn status:", req.session ? req.session.loggedIn : 'N/A');

    // Add a check for session store readiness if applicable (less common needed)

    if (req.session && req.session.loggedIn === true) {
        console.log("Authentication successful, proceeding.");
        return next();
    } else {
        console.log("Authentication failed.");
        // Log cookie details if possible (be careful with sensitive info)
        console.log("Cookies received:", req.headers.cookie); // Log received cookies for debugging

        if (req.originalUrl.startsWith('/api')) {
           console.log("API request unauthorized, sending 401.");
           return res.status(401).json({ error: 'Unauthorized - Please log in again.' });
        }
        console.log("Redirecting to login page.");
        res.redirect('/login.html');
    }
};


// --- Static Files & Route Protection ---
// Serve absolutely essential public files FIRST
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));
// Add any other necessary public assets for login page if needed

// Protect all other routes
app.get('/', isAuthenticated, (req, res) => res.redirect('/dashboard.html'));
app.get('/dashboard.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/categories.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'categories.html')));
app.get('/index.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/settings.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));
app.use('/api', isAuthenticated); // Protect API routes

// Serve remaining static files AFTER protection checks
app.use(express.static(path.join(__dirname)));


// --- API Endpoints ---
// ... (all other API endpoints remain exactly the same) ...
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

