const express = require('express');
const path = require('path');
const XLSX = require('xlsx');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const saltRounds = 10;

// --- Security & Session Setup (comes first) ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'a-very-strong-secret-key-for-hmc-system',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' } // Use secure cookies in production
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Important for login form data

// --- PostgreSQL Database Setup ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false // Required for Render connections
});

// --- Initialize Database ---
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
    console.log(">>> Received POST request on /login"); // New debug log
    const { password } = req.body;
    console.log("Login attempt with password:", password);
    try {
        const result = await pool.query("SELECT value FROM settings WHERE key = 'admin_password'");
        if (result.rows.length > 0) {
            const hashedPassword = result.rows[0].value;
            console.log("Stored hash:", hashedPassword);
            const match = await bcrypt.compare(password, hashedPassword);
            console.log("Password match result:", match);
            if (match) {
                req.session.loggedIn = true;
                console.log("Login successful, redirecting to dashboard.");
                return res.redirect('/dashboard.html');
            }
        }
        console.log("Login failed, redirecting back to login.");
        res.redirect('/login.html?error=1');
    } catch (err) {
        console.error('Login error:', err);
        res.redirect('/login.html?error=1');
    }
});
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login.html'));
});

// --- Auth Middleware (after login routes) ---
const isAuthenticated = (req, res, next) => {
    // Basic check if session exists and has loggedIn property
    if (req.session && req.session.loggedIn) {
        return next(); // User is authenticated, proceed to the next middleware/route handler
    }
    // User is not authenticated, redirect to login page
    res.redirect('/login.html');
};


// ========== تعديل الترتيب هنا ==========
// أولاً: تعريف الصفحات المحمية وحارس الأمن الخاص بها
app.get('/', (req, res) => res.redirect('/login.html')); // Root redirects to login
app.get('/dashboard.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/categories.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'categories.html')));
app.get('/index.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/settings.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));

// ثانياً: خدمة الملفات العامة (مثل CSS, JS, الصور) بعد التحقق من الصفحات المحمية
app.use(express.static(path.join(__dirname)));

// ثالثاً: حماية كل الـ APIs
app.use('/api', isAuthenticated);
// =====================================


// --- API Endpoints ---
app.post('/api/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    try {
        const result = await pool.query("SELECT value FROM settings WHERE key = 'admin_password'");
        if (result.rows.length === 0) { return res.status(500).json({ message: 'Server error.' }); }
        const match = await bcrypt.compare(currentPassword, result.rows[0].value);
        if (!match) { return res.status(400).json({ message: 'Incorrect current password.' }); }
        const hash = await bcrypt.hash(newPassword, saltRounds);
        await pool.query("UPDATE settings SET value = $1 WHERE key = 'admin_password'", [hash]);
        res.status(200).json({ message: 'Password changed successfully!' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ message: 'Failed to update password.' });
    }
});

app.get('/api/dashboard-stats', async (req, res) => {
    try {
        const lowStockRes = await pool.query("SELECT COUNT(*) as count FROM drugs WHERE quantity < 20");
        const expiringSoonRes = await pool.query("SELECT COUNT(*) as count FROM drugs WHERE expiry_date IS NOT NULL AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + interval '90 days'");
        const categoryCountsRes = await pool.query("SELECT category, COUNT(*) as count FROM drugs GROUP BY category");
        res.json({
            lowStockCount: parseInt(lowStockRes.rows[0].count, 10),
            expiringSoonCount: parseInt(expiringSoonRes.rows[0].count, 10),
            categoryCounts: categoryCountsRes.rows
        });
    } catch (err) {
        console.error('Dashboard stats error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/drugs', async (req, res) => {
    const { category, filter } = req.query;
    if (!category) { return res.status(400).json({ message: "Category is required." }); }
    let sql = "SELECT *, to_char(expiry_date, 'YYYY-MM-DD') as expiry_date FROM drugs WHERE category = $1";
    const params = [category];
    let paramIndex = 2;
    switch (filter) {
        case 'low_stock': sql += ` AND quantity < $${paramIndex++}`; params.push(20); break;
        case 'expiring_soon': sql += ` AND expiry_date IS NOT NULL AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + interval '90 days'`; break;
        case 'expired': sql += ` AND expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE`; break;
    }
    sql += " ORDER BY drug_name ASC";
    try {
        const result = await pool.query(sql, params);
        res.json({ drugs: result.rows });
    } catch (err) {
        console.error('Fetch drugs error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/drugs', async (req, res) => {
    const { drugCode, drugName, barcode, quantity, expiryDate, category } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const insertDrugSql = `INSERT INTO drugs (drug_code, drug_name, barcode, quantity, expiry_date, category) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
        const drugRes = await client.query(insertDrugSql, [drugCode, drugName, barcode || null, quantity, expiryDate || null, category]);
        const drug_id = drugRes.rows[0].id;
        try {
            const insertTransactionSql = `INSERT INTO transactions (drug_id, type, quantity_change, notes) VALUES ($1, 'Initial Add', $2, $3)`;
            await client.query(insertTransactionSql, [drug_id, quantity, 'Initial stock entry']);
        } catch (transactionErr) {
            console.error("Non-critical error inserting into transactions table:", transactionErr.message);
        }
        await client.query('COMMIT');
        res.status(201).json({ id: drug_id });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Add drug error:', err);
        res.status(500).json({ message: `Failed to add item: ${err.message}` });
    } finally {
        client.release();
    }
});

app.post('/api/drugs/withdraw/:id', async (req, res) => {
    const { id } = req.params;
    const { quantityToWithdraw, notes } = req.body;
    if (!quantityToWithdraw || quantityToWithdraw <= 0) { return res.status(400).json({ message: "Withdrawal quantity must be greater than zero." }); }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const drugRes = await client.query("SELECT quantity FROM drugs WHERE id = $1 FOR UPDATE", [id]);
        if (drugRes.rows.length === 0) { throw new Error("Item not found."); }
        const currentQuantity = drugRes.rows[0].quantity;
        if (currentQuantity < quantityToWithdraw) { throw new Error("Invalid quantity."); }
        const newQuantity = currentQuantity - quantityToWithdraw;
        await client.query("UPDATE drugs SET quantity = $1 WHERE id = $2", [newQuantity, id]);
        await client.query(`INSERT INTO transactions (drug_id, type, quantity_change, notes) VALUES ($1, 'Withdrawal', $2, $3)`, [id, -quantityToWithdraw, notes]);
        await client.query('COMMIT');
        res.status(200).json({ message: 'Withdrawal successful.', newQuantity });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Withdraw error:', err);
        res.status(400).json({ message: err.message || "Withdrawal failed." });
    } finally {
        client.release();
    }
});

app.delete('/api/drugs/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Transactions are deleted automatically due to ON DELETE CASCADE
        const result = await pool.query("DELETE FROM drugs WHERE id = $1", [id]);
        if (result.rowCount === 0) { return res.status(404).json({ message: 'Item not found.'}); }
        res.status(200).json({ message: 'Deletion successful.' });
    } catch (err) {
        console.error('Delete drug error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/drugs/:id', async (req, res) => {
    const { id } = req.params;
    const { drugCode, drugName, barcode, quantity, expiryDate, category } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const drugRes = await client.query("SELECT quantity FROM drugs WHERE id = $1 FOR UPDATE", [id]);
        if (drugRes.rows.length === 0) { throw new Error("Item not found."); }
        const oldQuantity = drugRes.rows[0].quantity;
        const sql = `UPDATE drugs SET drug_code = $1, drug_name = $2, barcode = $3, quantity = $4, expiry_date = $5, category = $6 WHERE id = $7`;
        await client.query(sql, [drugCode, drugName, barcode || null, quantity, expiryDate || null, category, id]);
        const quantityChange = quantity - oldQuantity;
        if (quantityChange !== 0) {
             await client.query(`INSERT INTO transactions (drug_id, type, quantity_change, notes) VALUES ($1, 'Update', $2, $3)`, [id, quantityChange, `Quantity updated from ${oldQuantity} to ${quantity}`]);
        } else {
             await client.query(`INSERT INTO transactions (drug_id, type, quantity_change, notes) VALUES ($1, 'Update', 0, 'Item details updated (quantity unchanged)')`, [id]);
        }
        await client.query('COMMIT');
        res.status(200).json({ message: 'Update successful.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Update drug error:', err);
        res.status(500).json({ message: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/report', async (req, res) => {
    const { category } = req.query;
    const sql = "SELECT drug_code as \"Item Code\", drug_name as \"Item Name\", barcode as \"Barcode\", quantity as \"Quantity\", to_char(expiry_date, 'YYYY-MM-DD') as \"Expiry Date\" FROM drugs WHERE category = $1";
    try {
        const result = await pool.query(sql, [category]);
        const worksheet = XLSX.utils.json_to_sheet(result.rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Items");
        const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
        res.setHeader('Content-Disposition', `attachment; filename=Report_${category}.xlsx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error('Report error:', err);
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/transaction-report', async (req, res) => {
    const { category } = req.query;
    const sql = `SELECT to_char(t.timestamp, 'YYYY-MM-DD HH24:MI:SS') AS "Date/Time", d.drug_name AS "Item Name", d.drug_code AS "Item Code", d.barcode AS "Barcode", t.type AS "Transaction Type", t.quantity_change AS "Quantity Change", t.notes AS "Notes" FROM transactions t JOIN drugs d ON t.drug_id = d.id WHERE d.category = $1 ORDER BY t.timestamp DESC`;
    try {
        const result = await pool.query(sql, [category]);
        const worksheet = XLSX.utils.json_to_sheet(result.rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Transaction History");
        const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
        res.setHeader('Content-Disposition', `attachment; filename=Transaction_Report_${category}.xlsx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error('Transaction report error:', err);
        res.status(500).json({ message: err.message });
    }
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

