const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const XLSX = require('xlsx');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;
const saltRounds = 10;

// --- إعدادات الحماية وتسجيل الدخول ---
app.use(session({
    secret: 'a-very-strong-secret-key-for-hmc-system',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- إعداد قاعدة البيانات ---
const db = new sqlite3.Database('./warehouse.db', (err) => {
    if (err) { console.error('DATABASE CONNECTION ERROR', err.message); }
    else { console.log('Successfully connected to warehouse.db.'); }
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS drugs (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_code TEXT NOT NULL, drug_name TEXT NOT NULL, barcode TEXT, quantity INTEGER NOT NULL, expiry_date TEXT, category TEXT NOT NULL, UNIQUE(drug_code, category), UNIQUE(barcode, category))`);
        db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER, type TEXT NOT NULL, quantity_change INTEGER NOT NULL, notes TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (drug_id) REFERENCES drugs(id))`);
        db.get("SELECT value FROM settings WHERE key = 'admin_password'", (err, row) => {
            if (!row) {
                bcrypt.hash('12345', saltRounds, (err, hash) => {
                    if (err) return console.error("Error hashing default password:", err);
                    db.run("INSERT INTO settings (key, value) VALUES ('admin_password', ?)", [hash]);
                    console.log('Default hashed password has been set.');
                });
            }
        });
    });
});

// --- Endpoints تسجيل الدخول والخروج ---
app.post('/login', (req, res) => {
    const { password } = req.body;
    db.get("SELECT value FROM settings WHERE key = 'admin_password'", (err, row) => {
        if (err || !row) { return res.redirect('/login.html?error=1'); }
        bcrypt.compare(password, row.value, (err, result) => {
            if (result) {
                req.session.loggedIn = true;
                res.redirect('/dashboard.html');
            } else {
                res.redirect('/login.html?error=1');
            }
        });
    });
});
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login.html'));
});

// --- Middleware للتحقق من تسجيل الدخول ---
const isAuthenticated = (req, res, next) => {
    if (req.session.loggedIn) { next(); } else { res.redirect('/login.html'); }
};

// ========== هذا هو التعديل المهم ==========
// أولاً، نحدد الصفحات المحمية ليتم التحقق منها بواسطة حارس الأمن
app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/dashboard.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/categories.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'categories.html')));
app.get('/index.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/settings.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));

// ثانياً، نسمح للبواب بالوصول إلى بقية الملفات العامة (CSS, JS, الصور)
app.use(express.static(path.join(__dirname)));

// ثالثاً، نحمي كل الـ APIs
app.use('/api', isAuthenticated);
// ==========================================


// --- API Endpoints ---
// ... (كل بقية الكود تبقى كما هي تمامًا)
app.post('/api/change-password', (req, res) => {
    const { currentPassword, newPassword } = req.body;
    db.get("SELECT value FROM settings WHERE key = 'admin_password'", (err, row) => {
        if (err || !row) { return res.status(500).json({ message: 'Server error.' }); }
        
        bcrypt.compare(currentPassword, row.value, (err, result) => {
            if (!result) {
                return res.status(400).json({ message: 'Incorrect current password.' });
            }
            bcrypt.hash(newPassword, saltRounds, (err, hash) => {
                if (err) { return res.status(500).json({ message: 'Failed to hash new password.' }); }
                db.run("UPDATE settings SET value = ? WHERE key = 'admin_password'", [hash], (err) => {
                    if (err) { return res.status(500).json({ message: 'Failed to update password.' }); }
                    res.status(200).json({ message: 'Password changed successfully!' });
                });
            });
        });
    });
});

app.get('/api/dashboard-stats', (req, res) => {
    const queries = {
        lowStock: "SELECT COUNT(*) as count FROM drugs WHERE quantity < 20",
        expiringSoon: "SELECT COUNT(*) as count FROM drugs WHERE expiry_date IS NOT NULL AND date(expiry_date) BETWEEN date('now') AND date('now', '+90 days')",
        categoryCounts: "SELECT category, COUNT(*) as count FROM drugs GROUP BY category"
    };
    Promise.all([
        new Promise((resolve, reject) => db.get(queries.lowStock, (err, row) => err ? reject(err) : resolve(row.count))),
        new Promise((resolve, reject) => db.get(queries.expiringSoon, (err, row) => err ? reject(err) : resolve(row.count))),
        new Promise((resolve, reject) => db.all(queries.categoryCounts, (err, rows) => err ? reject(err) : resolve(rows)))
    ]).then(([lowStockCount, expiringSoonCount, categoryCounts]) => {
        res.json({ lowStockCount, expiringSoonCount, categoryCounts });
    }).catch(err => res.status(500).json({ error: err.message }));
});

app.get('/api/drugs', (req, res) => {
    const { category, filter } = req.query;
    if (!category) { return res.status(400).json({ message: "Category is required." }); }
    let sql = "SELECT * FROM drugs WHERE category = ?";
    const params = [category];
    switch (filter) {
        case 'low_stock': sql += " AND quantity < 20"; break;
        case 'expiring_soon': sql += " AND expiry_date IS NOT NULL AND date(expiry_date) BETWEEN date('now') AND date('now', '+90 days')"; break;
        case 'expired': sql += " AND expiry_date IS NOT NULL AND date(expiry_date) < date('now')"; break;
    }
    sql += " ORDER BY drug_name ASC";
    db.all(sql, params, (err, rows) => {
        if (err) { return res.status(500).json({ error: err.message }); }
        res.json({ drugs: rows });
    });
});

app.post('/api/drugs', (req, res) => {
    const { drugCode, drugName, barcode, quantity, expiryDate, category } = req.body;
    db.serialize(() => {
        const insertDrugSql = `INSERT INTO drugs (drug_code, drug_name, barcode, quantity, expiry_date, category) VALUES (?, ?, ?, ?, ?, ?)`;
        db.run(insertDrugSql, [drugCode, drugName, barcode || null, quantity, expiryDate || null, category], function (err) {
            if (err) {
                console.error("Error inserting into drugs table:", err.message);
                return res.status(500).json({ message: err.message });
            }
            const drug_id = this.lastID;
            const insertTransactionSql = `INSERT INTO transactions (drug_id, type, quantity_change, notes) VALUES (?, 'Initial Add', ?, ?)`;
            db.run(insertTransactionSql, [drug_id, quantity, 'Initial stock entry'], (err) => {
                if (err) {
                    console.error("Error inserting into transactions table:", err.message);
                }
                res.status(201).json({ id: drug_id });
            });
        });
    });
});

app.post('/api/drugs/withdraw/:id', (req, res) => {
    const { id } = req.params;
    const { quantityToWithdraw, notes } = req.body;
    if (!quantityToWithdraw || quantityToWithdraw <= 0) { return res.status(400).json({ message: "Withdrawal quantity must be greater than zero." }); }
    db.get("SELECT quantity FROM drugs WHERE id = ?", [id], (err, drug) => {
        if (err || !drug || drug.quantity < quantityToWithdraw) { return res.status(400).json({ message: "Invalid quantity or item not found." }); }
        const newQuantity = drug.quantity - quantityToWithdraw;
        db.serialize(() => {
            db.run("UPDATE drugs SET quantity = ? WHERE id = ?", [newQuantity, id]);
            db.run(`INSERT INTO transactions (drug_id, type, quantity_change, notes) VALUES (?, 'Withdrawal', ?, ?)`, [id, -quantityToWithdraw, notes]);
            res.status(200).json({ message: 'Withdrawal successful.', newQuantity });
        });
    });
});

app.delete('/api/drugs/:id', (req, res) => {
    const id = req.params.id;
    db.serialize(() => {
        db.run(`DELETE FROM transactions WHERE drug_id = ?`, [id], (err) => {
             if (err) { console.error("Error deleting transactions:", err.message); }
        });
        db.run("DELETE FROM drugs WHERE id = ?", id, (err) => {
            if (err) { return res.status(500).json({ error: err.message }); }
            res.status(200).json({ message: 'Deletion successful.' });
        });
    });
});

app.put('/api/drugs/:id', (req, res) => {
    const { id } = req.params;
    const { drugCode, drugName, barcode, quantity, expiryDate, category } = req.body;
    db.get("SELECT quantity FROM drugs WHERE id = ?", [id], (err, drug) => {
        const oldQuantity = drug ? drug.quantity : 0;
        const sql = `UPDATE drugs SET drug_code = ?, drug_name = ?, barcode = ?, quantity = ?, expiry_date = ?, category = ? WHERE id = ?`;
        db.run(sql, [drugCode, drugName, barcode || null, quantity, expiryDate || null, category, id], (err) => {
            if (err) { return res.status(500).json({ message: err.message }); }
            const quantityChange = quantity - oldQuantity;
            db.run(`INSERT INTO transactions (drug_id, type, quantity_change, notes) VALUES (?, 'Update', ?, ?)`, [id, quantityChange, `Quantity updated from ${oldQuantity} to ${quantity}`]);
            res.status(200).json({ message: 'Update successful.' });
        });
    });
});

app.get('/api/report', (req, res) => {
    const { category } = req.query;
    const sql = "SELECT drug_code as 'Item Code', drug_name as 'Item Name', barcode as 'Barcode', quantity as 'Quantity', expiry_date as 'Expiry Date' FROM drugs WHERE category = ?";
    db.all(sql, [category], (err, rows) => {
        if (err) { return res.status(500).json({ message: err.message }); }
        const worksheet = XLSX.utils.json_to_sheet(rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Items");
        const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
        res.setHeader('Content-Disposition', `attachment; filename=Report_${category}.xlsx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    });
});

app.get('/api/transaction-report', (req, res) => {
    const { category } = req.query;
    const sql = `SELECT t.timestamp AS 'Date/Time', d.drug_name AS 'Item Name', d.drug_code AS 'Item Code', d.barcode AS 'Barcode', t.type AS 'Transaction Type', t.quantity_change AS 'Quantity Change', t.notes AS 'Notes' FROM transactions t JOIN drugs d ON t.drug_id = d.id WHERE d.category = ? ORDER BY t.timestamp DESC`;
    db.all(sql, [category], (err, rows) => {
        if (err) { return res.status(500).json({ message: err.message }); }
        const worksheet = XLSX.utils.json_to_sheet(rows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Transaction History");
        const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
        res.setHeader('Content-Disposition', `attachment; filename=Transaction_Report_${category}.xlsx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    });
});

// --- تشغيل الخادم ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

