const express = require('express');
const path = require('path');
const XLSX = require('xlsx');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg'); // <-- استيراد أداة PostgreSQL

const app = express();
const PORT = process.env.PORT || 3000;
const saltRounds = 10;

// --- إعدادات الحماية وتسجيل الدخول ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'a-very-strong-secret-key-for-hmc-system', // استخدام متغير بيئة
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' } // تفعيل secure cookies في الإنتاج
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- إعداد الاتصال بقاعدة بيانات PostgreSQL ---
// سيتم أخذ رابط الاتصال من متغيرات البيئة على Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false // مطلوب للاتصال بـ Render
});

// دالة لإنشاء الجداول عند أول تشغيل إذا لم تكن موجودة
const initializeDatabase = async () => {
    const client = await pool.connect();
    try {
        // جدول الإعدادات
        await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
        // جدول الأصناف
        await client.query(`
            CREATE TABLE IF NOT EXISTS drugs (
                id SERIAL PRIMARY KEY,
                drug_code TEXT NOT NULL,
                drug_name TEXT NOT NULL,
                barcode TEXT,
                quantity INTEGER NOT NULL,
                expiry_date DATE, -- استخدام نوع DATE
                category TEXT NOT NULL,
                UNIQUE(drug_code, category),
                UNIQUE(barcode, category)
            );
        `);
        // جدول الحركات
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                drug_id INTEGER REFERENCES drugs(id) ON DELETE CASCADE, -- لربط الحركات بالأصناف
                type TEXT NOT NULL,
                quantity_change INTEGER NOT NULL,
                notes TEXT,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP -- استخدام TIMESTAMPTZ
            );
        `);

        // إضافة كلمة مرور افتراضية مشفرة
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
        client.release(); // تحرير الاتصال
    }
};

initializeDatabase(); // استدعاء الدالة لإنشاء الجداول

// --- Endpoints تسجيل الدخول والخروج (مع تحديث الاستعلامات) ---
app.post('/login', async (req, res) => {
    const { password } = req.body;
    try {
        const result = await pool.query("SELECT value FROM settings WHERE key = 'admin_password'");
        if (result.rows.length > 0) {
            const match = await bcrypt.compare(password, result.rows[0].value);
            if (match) {
                req.session.loggedIn = true;
                return res.redirect('/dashboard.html');
            }
        }
        res.redirect('/login.html?error=1');
    } catch (err) {
        console.error('Login error:', err);
        res.redirect('/login.html?error=1');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login.html'));
});

// --- Middleware للتحقق من تسجيل الدخول ---
const isAuthenticated = (req, res, next) => {
    if (req.session.loggedIn) { next(); } else { res.redirect('/login.html'); }
};

// --- خدمة الملفات العامة والحماية ---
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/dashboard.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/categories.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'categories.html')));
app.get('/index.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/settings.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));
app.use('/api', isAuthenticated);

// --- API Endpoints (مع تحديث الاستعلامات لـ PostgreSQL) ---
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
        // تعديل استعلام التاريخ لـ PostgreSQL
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
    let sql = "SELECT *, to_char(expiry_date, 'YYYY-MM-DD') as expiry_date FROM drugs WHERE category = $1"; // تنسيق التاريخ
    const params = [category];
    let paramIndex = 2; // مؤشر للـ parameters في PostgreSQL
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
        await client.query('BEGIN'); // بدء transaction
        const insertDrugSql = `INSERT INTO drugs (drug_code, drug_name, barcode, quantity, expiry_date, category) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`; // RETURNING id للحصول على ID الجديد
        const drugRes = await client.query(insertDrugSql, [drugCode, drugName, barcode || null, quantity, expiryDate || null, category]);
        const drug_id = drugRes.rows[0].id;

        const insertTransactionSql = `INSERT INTO transactions (drug_id, type, quantity_change, notes) VALUES ($1, 'Initial Add', $2, $3)`;
        await client.query(insertTransactionSql, [drug_id, quantity, 'Initial stock entry']);

        await client.query('COMMIT'); // تأكيد transaction
        res.status(201).json({ id: drug_id });
    } catch (err) {
        await client.query('ROLLBACK'); // التراجع في حالة الخطأ
        console.error('Add drug error:', err);
        res.status(500).json({ message: err.message });
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
        // قفل الصف لمنع التعديلات المتزامنة (أكثر أمانًا)
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
    // لا حاجة لحذف الحركات بسبب ON DELETE CASCADE
    try {
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

// تعديل التقارير لتنسيق التاريخ
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
    // تعديل تنسيق الوقت
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

// --- تشغيل الخادم ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

