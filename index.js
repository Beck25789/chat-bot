// === IMPORT LIBRARIES ===
const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const fs = require('fs');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const ChartDataLabels = require('chartjs-plugin-datalabels');
const TelegramBot = require('node-telegram-bot-api');
const { createCanvas, loadImage } = require('canvas');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

// === CONFIG ===
const app = express();
const port = 3000;
const token = '7813036730:AAFFvYd7g9Sp6dT3QfJkAPAYeq0E_XDQ3Xc'; // Telegram bot token 
const groupId = -1002870074436;
const bot = new TelegramBot(token, { polling: true });
const JWT_SECRET = 'secret-key-or-booking';

// === MIDDLEWARE ===
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(cookieParser());

// === DATABASE POOL ===
const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'booking',
});

// === EXPRESS ROUTES ===
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/auth', (req, res) => {
    res.sendFile(__dirname + '/public/auth.html');
});

// --- REGISTER USER ---
app.post('/register', async (req, res) => {
    const { username, password, name, phone } = req.body;

    try {
        const [rows] = await db.query('SELECT * FROM booking_user WHERE username = ?', [username]);
        if (rows.length > 0) {
            return res.send('<p>Username already exists. <a href="/auth">Try again</a></p>');
        }

        await db.query(
            'INSERT INTO booking_user (username, password, name, phone) VALUES (?, ?, ?, ?)',
            [username, password, name, phone]
        );

        res.send('<p>Register success. <a href="/auth">Go to Login</a></p>');
    } catch (err) {
        console.error(err);
        res.status(500).send('Register failed');
    }
});

// --- LOGIN USER ---
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const [rows] = await db.query(
            'SELECT * FROM booking_user WHERE username = ? AND password = ?',
            [username, password]
        );

        if (rows.length === 0) {
            return res.send('<p>Login failed. <a href="/auth">Try again</a></p>');
        }

        const user = rows[0];
        const token = jwt.sign(
            { id: user.id, username: user.username, name: user.name, phone: user.phone },
            JWT_SECRET,
            { expiresIn: '1h' }
        );

        res.cookie('token', token, { httpOnly: false });
        res.redirect('/index.html');
    } catch (err) {
        console.error(err);
        res.status(500).send('Login error');
    }
});

// --- GET CURRENT USER INFO ---
app.get('/me', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const user = jwt.verify(token, JWT_SECRET);
        // ส่ง id ของผู้ใช้กลับไปด้วย
        res.json({ id: user.id, name: user.name, phone: user.phone });
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
});


// === BOOKING SUBMIT ===
app.post('/submit', async (req, res) => {
    const {
        room_id,
        attendees,
        topic,
        age,
        diagnosis,
        operation,
        bloodcomponent,
        currentdrug,
        name,
        phone,
        userId, // รับ userId ที่ส่งมาจาก frontend
        use,
        department,
        npo,
        otype,
        start_datetime,
        end_datetime,
        status,
        comment
    } = req.body;

    const commentText = Array.isArray(comment) ? comment.join(', ') : comment || '';
    const createDate = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const statusMap = {
        0: 'รอตรวจสอบ',
        1: 'อนุมัติ รอผ่าตัด',
        2: 'ไม่อนุมัติ',
        3: 'OFF case',
        4: 'ยกเลิกโดยเจ้าหน้าที่',
        5: 'ผ่าตัดเสร็จแล้ว',
        6: 'PREVISIT รออนุมัติ',
    };
    const statusText = statusMap[status] || 'ไม่ทราบสถานะ';

    try {
        // อัปเดตข้อมูลชื่อและเบอร์โทรศัพท์ของผู้ใช้ในตาราง booking_user
        if (userId && name && phone) {
            await db.query(
                'UPDATE booking_user SET name = ?, phone = ? WHERE id = ?',
                [name, phone, userId]
            );
        }

        const [roomResult] = await db.query('SELECT name FROM booking_rooms WHERE id = ?', [room_id]);
        if (roomResult.length === 0) {
            return res.status(404).send('ไม่พบชื่อห้อง');
        }

        const roomName = roomResult[0].name;

        const insertSQL = `
            INSERT INTO booking_reservation (
                room_id, member_id, create_date, topic, comment, attendees,
                begin, end, status, reason, approver, approved_date,
                operation, diagnosis, operationtype, npotime,
                bloodcomponent, currentdrug, age
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const values = [
            room_id,
            userId, // ใช้ userId ที่รับมาจาก frontend เพื่อระบุผู้จอง
            createDate,
            topic,
            commentText,
            attendees,
            start_datetime,
            end_datetime,
            status,
            '', // reason - not provided in either request body
            use, // approver - derived from 'use' in both codes
            createDate, // approved_date - derived from createDate in both codes
            operation,
            diagnosis,
            otype,
            npo,
            bloodcomponent,
            currentdrug,
            age
        ];

        const formattedStart = formatDate(start_datetime);
        const formattedEnd = formatDate(end_datetime);

        await db.query(insertSQL, values);

        const msg = `
*ORBooking : จองห้องผ่าตัด*

*ชื่อผู้จอง :* ${name}
*ห้องผ่าตัด :* ${roomName}
*HN :* ${attendees}
*ชื่อ-นามสกุล :* ${topic}
*Diagnosis :* ${diagnosis}
*Operation :* ${operation}
*เริ่มต้น :* ${formattedStart} น.
*สิ้นสุด :* ${formattedEnd} น.
*สถานะ :* ${statusText}
        `.trim();

        bot.sendMessage(groupId, msg, { parse_mode: 'Markdown' });

        res.send('<h2>บันทึกเรียบร้อยแล้ว</h2><a href="/">กลับ</a>');

    } catch (err) {
        console.error(err);
        res.status(500).send('เกิดข้อผิดพลาดในระบบ');
    }
});

// === HELPER FUNCTIONS ===
function formatDate(datetimeStr) {
    const date = new Date(datetimeStr);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function generateReportID() {
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';

    const pick = (str, len) =>
        Array.from({ length: len }, () => str.charAt(Math.floor(Math.random() * str.length)));

    const result = [...pick(upper, 3), ...pick(lower, 3), ...pick(digits, 4)];
    return '#ReportID: ' + result.sort(() => 0.5 - Math.random()).join('');
}

function getTimestamp() {
    const now = new Date();
    const options = {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    };

    const localeString = now.toLocaleString('sv-SE', options);
    return localeString.replace(' ', 'T').replace('T', ' ').replaceAll('.', '-');
}

// === TELEGRAM BOT COMMANDS AND FUNCTIONS ===
let commandUsage = {};

// Function to check and update command status (rate limiting)
function canProcessCommand(command) {
    const now = Date.now();
    if (!commandUsage[command]) {
        commandUsage[command] = { firstCall: now, count: 1 };
        return 1; // Return 1 for first call (process normally)
    }
    const elapsed = now - commandUsage[command].firstCall;

    if (elapsed > 60000) { // If more than 1 minute has passed, reset
        commandUsage[command] = { firstCall: now, count: 1 };
        return 1; // Reset and allow
    } else {
        commandUsage[command].count++;
        if (commandUsage[command].count === 2) {
            return 2; // Second call within a minute, inform to wait
        }
        if (commandUsage[command].count > 2) {
            return 3; // Third or more call within a minute, silently ignore
        }
    }
}

// --- /room command (overall) ---
bot.onText(/\/room$/, async (msg) => {
    if (msg.chat.id !== groupId) return;

    const status = canProcessCommand('/room');
    if (status === 2) {
        return bot.sendMessage(groupId, '⏳ กรุณารอ 1 นาที ก่อนเรียกดูกราฟอีกครั้ง โดยใช้คำสั่งเดิม');
    }
    if (status === 3) return;

    await bot.sendMessage(groupId, '📊 กำลังสร้างกราฟการใช้งานห้องผ่าตัด...');
    await generateRoomUsageChart();
});

async function generateRoomUsageChart() {
    try {
        const [rows] = await db.query(`
            SELECT room_id, COUNT(*) AS count
            FROM booking_reservation
            GROUP BY room_id
        `);

        const roomCounts = {};
        rows.forEach(row => {
            roomCounts[row.room_id] = row.count;
        });

        const reportId = generateReportID();
        await createRoomUsageChart(roomCounts, reportId);

        const filename = `room-usage-${reportId.replace('#ReportID: ', '')}.png`;
        await bot.sendPhoto(groupId, fs.createReadStream(filename), {
            caption: `🏥 สรุปจำนวนการใช้งานห้องผ่าตัดทั้งหมด\n${reportId}`,
        });

        fs.unlinkSync(filename);

    } catch (err) {
        console.error(err);
        await bot.sendMessage(groupId, '❌ ไม่สามารถสร้างกราฟห้องได้');
    }
}

async function createRoomUsageChart(data, reportId, labelText = null) {
    const width = 800;
    const height = 600;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({
        width,
        height,
        plugins: {
            modern: ['chartjs-plugin-datalabels'],
        },
    });

    const roomNameMap = {
        8: 'ห้อง SMC',
        5: 'ห้อง1 ชั้น1',
        1: 'ห้อง1 ชั้น4',
        6: 'ห้อง2 ชั้น1',
        2: 'ห้อง2 ชั้น4',
        7: 'ห้อง3 ชั้น1',
        3: 'ห้อง3 ชั้น4 EMERGENCY',
        4: 'ห้อง4 ชั้น4',
    };

    const roomIds = Object.keys(roomNameMap);
    const labels = roomIds.map(id => roomNameMap[id]);
    const counts = roomIds.map(id => data[id] || 0);

    const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#00A65A', '#D81B60'];
    const timestamp = getTimestamp();

    const config = {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'จำนวนการใช้งาน',
                data: counts,
                backgroundColor: colors,
            }],
        },
        options: {
            responsive: false,
            plugins: {
                title: {
                    display: true,
                    text: (() => {
                        if (labelText && labelText.match(/^\d{1,2}\/\d{4}$/)) {
                            return `สรุปจำนวนการใช้งานห้องผ่าตัด (เดือน ${labelText})`;
                        }
                        else if (labelText && labelText.match(/^\d{4}$/)) {
                            return `สรุปจำนวนการใช้งานห้องผ่าตัด ( ${labelText})`;
                        }
                        else if (labelText) {
                            return `สรุปจำนวนการใช้งานห้องผ่าตัด (${labelText})`;
                        }
                        return 'สรุปจำนวนการใช้งานห้องผ่าตัด';
                    })(),
                    font: { size: 20 },
                },
                legend: { display: false },
                datalabels: {
                    anchor: 'start',
                    align: 'end',
                    offset: 4,
                    color: '#000',
                    font: { size: 14 },
                    formatter: value => value,
                },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'จำนวนการใช้งาน' },
                },
                x: {
                    ticks: {
                        autoSkip: false,
                        maxRotation: 30,
                        minRotation: 0,
                    },
                },
            },
        },
        plugins: [ChartDataLabels],
    };

    const buffer = await chartJSNodeCanvas.renderToBuffer(config);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const img = await loadImage(buffer);
    ctx.drawImage(img, 0, 0, width, height);

    ctx.font = '16px Arial';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillText(reportId, 10, height - 30);
    ctx.fillText(`${getTimestamp()}`, 10, height - 10);

    const filename = `room-usage-${reportId.replace('#ReportID: ', '')}.png`;
    const finalBuffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filename, finalBuffer);
}

// --- /status command (overall) ---
bot.onText(/\/status$/, async (msg) => {
    if (msg.chat.id !== groupId) return;

    const status = canProcessCommand('/status');
    if (status === 2) {
        return bot.sendMessage(groupId, '⏳ กรุณารอ 1 นาที ก่อนเรียกดูกราฟอีกครั้ง โดยใช้คำสั่งเดิม');
    }
    if (status === 3) return;

    await bot.sendMessage(groupId, '⏳ กำลังสร้างกราฟ...');
    await generateAndSendChart();
});

async function generateAndSendChart() {
    try {
        const [rows] = await db.query('SELECT status, COUNT(*) AS count FROM booking_reservation GROUP BY status');
        const statusCount = {};
        rows.forEach(row => {
            statusCount[row.status] = row.count;
        });

        const reportId = generateReportID();
        await createStatusChart(statusCount, reportId);

        const filename = `status-chart-${reportId.replace('#ReportID: ', '')}.png`;
        await bot.sendPhoto(groupId, fs.createReadStream(filename), {
            caption: `📊 สรุปสถานะการจองห้องผ่าตัด\n${reportId}`,
        });

        fs.unlinkSync(filename);

    } catch (err) {
        console.error(err);
        await bot.sendMessage(groupId, '❌ ไม่สามารถสร้างกราฟได้');
    }
}

async function createStatusChart(data, reportId, labelText = null) {
    const width = 800;
    const height = 600;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({
        width,
        height,
        plugins: {
            modern: ['chartjs-plugin-datalabels'],
        },
    });

    const statusLabels = {
        0: 'รอตรวจสอบ',
        1: 'อนุมัติ รอผ่าตัด',
        2: 'ไม่อนุมัติ',
        3: 'OFF case',
        4: 'ยกเลิกโดยเจ้าหน้าที่',
        5: 'ผ่าตัดเสร็จแล้ว',
        6: 'PREVISIT รออนุมัติ',
    };

    const colors = ['#FF5733', '#33FF57', '#3357FF', '#FF33A1', '#FFC300', '#8E44AD', '#1ABC9C'];
    const labels = Object.values(statusLabels);
    const counts = Object.keys(statusLabels).map(key => data[key] || 0);
    const timestamp = getTimestamp();

    const config = {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'จำนวนเคส',
                data: counts,
                backgroundColor: colors,
            }],
        },
        options: {
            responsive: false,
            plugins: {
                title: {
                    display: true,
                    text: (() => {
                        if (labelText && labelText.match(/^\d{1,2}\/\d{4}$/)) {
                            return `สรุปสถานะการจองห้องผ่าตัด (เดือน ${labelText})`;
                        }
                        else if (labelText && labelText.match(/^\d{4}$/)) {
                            return `สรุปสถานะการจองห้องผ่าตัด ( ${labelText})`;
                        }
                        else if (labelText) {
                            return `สรุปสถานะการจองห้องผ่าตัด (${labelText})`;
                        }
                        return 'สรุปสถานะการจองห้องผ่าตัด';
                    })(),
                    font: { size: 20 },
                },
                legend: { display: false },
                datalabels: {
                    anchor: 'start',
                    align: 'end',
                    offset: 4,
                    color: '#000',
                    font: { size: 14 },
                    formatter: value => value,
                },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'จำนวน (เคส)' },
                },
                x: {
                    ticks: {
                        autoSkip: false,
                        maxRotation: 45,
                        minRotation: 0,
                    },
                },
            },
        },
        plugins: [ChartDataLabels],
    };

    const buffer = await chartJSNodeCanvas.renderToBuffer(config);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const img = await loadImage(buffer);
    ctx.drawImage(img, 0, 0, width, height);

    ctx.font = '16px Arial';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillText(reportId, 10, height - 30);
    ctx.fillText(`${getTimestamp()}`, 10, height - 10);

    const filename = `status-chart-${reportId.replace('#ReportID: ', '')}.png`;
    const finalBuffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filename, finalBuffer);
}

// --- /status month/year command ---
bot.onText(/\/status (\d{1,2})\/(\d{4})$/, async (msg, match) => {
    if (msg.chat.id !== groupId) return;

    const status = canProcessCommand('/status เดือน/ปี');
    if (status === 2) {
        return bot.sendMessage(groupId, '⏳ กรุณารอ 1 นาที ก่อนเรียกดูกราฟอีกครั้ง');
    }
    if (status === 3) return;

    const month = parseInt(match[1]);
    const buddhistYear = parseInt(match[2]);
    const year = buddhistYear - 543;

    if (month < 1 || month > 12) {
        return bot.sendMessage(groupId, '❌ เดือนต้องอยู่ระหว่าง 1 ถึง 12');
    }

    await bot.sendMessage(groupId, `📅 กำลังสร้างกราฟสำหรับเดือน ${month}/${buddhistYear} ...`);
    await generateMonthlyChart(month, year, `${month}/${buddhistYear}`);
});

async function generateMonthlyChart(month, year, labelText) {
    try {
        const [rows] = await db.query(`
            SELECT status, COUNT(*) AS count
            FROM booking_reservation
            WHERE MONTH(begin) = ? AND YEAR(begin) = ?
            GROUP BY status
        `, [month, year]);

        const statusCount = {};
        rows.forEach(row => {
            statusCount[row.status] = row.count;
        });

        const reportId = generateReportID();
        await createStatusChart(statusCount, reportId, labelText);

        const filename = `status-chart-${reportId.replace('#ReportID: ', '')}.png`;
        await bot.sendPhoto(groupId, fs.createReadStream(filename), {
            caption: `📊 สรุปสถานะการจองห้องผ่าตัด เดือน ${labelText}\n${reportId}`,
        });

        fs.unlinkSync(filename);
    } catch (err) {
        console.error(err);
        await bot.sendMessage(groupId, '❌ ไม่สามารถสร้างกราฟรายเดือนได้');
    }
}

// --- /status year command ---
bot.onText(/\/status (\d{4})$/, async (msg, match) => {
    if (msg.chat.id !== groupId) return;

    const status = canProcessCommand('/status ปี');
    if (status === 2) {
        return bot.sendMessage(groupId, '⏳ กรุณารอ 1 นาที ก่อนเรียกดูกราฟอีกครั้ง');
    }
    if (status === 3) return;

    const buddhistYear = parseInt(match[1]);
    const year = buddhistYear - 543;

    await bot.sendMessage(groupId, `📅 กำลังสร้างกราฟสำหรับปี ${buddhistYear} ...`);
    await generateYearlyChart(year, `${buddhistYear}`);
});

async function generateYearlyChart(year, labelText) {
    try {
        const [rows] = await db.query(`
            SELECT status, COUNT(*) AS count
            FROM booking_reservation
            WHERE YEAR(begin) = ?
            GROUP BY status
        `, [year]);

        const statusCount = {};
        rows.forEach(row => {
            statusCount[row.status] = row.count;
        });

        const reportId = generateReportID();
        await createStatusChart(statusCount, reportId, labelText);

        const filename = `status-chart-${reportId.replace('#ReportID: ', '')}.png`;
        await bot.sendPhoto(groupId, fs.createReadStream(filename), {
            caption: `📊 สรุปสถานะการจองห้องผ่าตัด ปี ${labelText}\n${reportId}`,
        });

        fs.unlinkSync(filename);
    } catch (err) {
        console.error(err);
        await bot.sendMessage(groupId, '❌ ไม่สามารถสร้างกราฟรายปีได้');
    }
}

// --- /room month/year command ---
bot.onText(/\/room (\d{1,2})\/(\d{4})$/, async (msg, match) => {
    if (msg.chat.id !== groupId) return;

    const status = canProcessCommand('/room เดือน/ปี');
    if (status === 2) {
        return bot.sendMessage(groupId, '⏳ กรุณารอ 1 นาที ก่อนเรียกดูกราฟอีกครั้ง');
    }
    if (status === 3) return;

    const month = parseInt(match[1]);
    const buddhistYear = parseInt(match[2]);
    const year = buddhistYear - 543;

    if (month < 1 || month > 12) {
        return bot.sendMessage(groupId, '❌ เดือนต้องอยู่ระหว่าง 1 ถึง 12');
    }

    await bot.sendMessage(groupId, `📅 กำลังสร้างกราฟสำหรับเดือน ${month}/${buddhistYear} ...`);
    await generateMonthlyRoomChart(month, year, `${month}/${buddhistYear}`);
});

async function generateMonthlyRoomChart(month, year, labelText) {
    try {
        const [rows] = await db.query(`
            SELECT room_id, COUNT(*) AS count
            FROM booking_reservation
            WHERE MONTH(begin) = ? AND YEAR(begin) = ?
            GROUP BY room_id
        `, [month, year]);

        const roomCounts = {};
        rows.forEach(row => {
            roomCounts[row.room_id] = row.count;
        });

        const reportId = generateReportID();
        await createRoomUsageChart(roomCounts, reportId, labelText);

        const filename = `room-usage-${reportId.replace('#ReportID: ', '')}.png`;
        await bot.sendPhoto(groupId, fs.createReadStream(filename), {
            caption: `🏥 สรุปจำนวนการใช้งานห้องผ่าตัด เดือน ${labelText}\n${reportId}`,
        });

        fs.unlinkSync(filename);
    } catch (err) {
        console.error(err);
        await bot.sendMessage(groupId, '❌ ไม่สามารถสร้างกราฟห้องรายเดือนได้');
    }
}

// --- /room year command ---
bot.onText(/\/room (\d{4})$/, async (msg, match) => {
    if (msg.chat.id !== groupId) return;

    const status = canProcessCommand('/room ปี');
    if (status === 2) {
        return bot.sendMessage(groupId, '⏳ กรุณารอ 1 นาที ก่อนเรียกดูกราฟอีกครั้ง');
    }
    if (status === 3) return;

    const buddhistYear = parseInt(match[1]);
    const year = buddhistYear - 543;

    await bot.sendMessage(groupId, `📅 กำลังสร้างกราฟสำหรับปี ${buddhistYear} ...`);
    await generateYearlyRoomChart(year, `${buddhistYear}`);
});

async function generateYearlyRoomChart(year, labelText) {
    try {
        const [rows] = await db.query(`
            SELECT room_id, COUNT(*) AS count
            FROM booking_reservation
            WHERE YEAR(begin) = ?
            GROUP BY room_id
        `, [year]);

        const roomCounts = {};
        rows.forEach(row => {
            roomCounts[row.room_id] = row.count;
        });

        const reportId = generateReportID();
        await createRoomUsageChart(roomCounts, reportId, labelText);

        const filename = `room-usage-${reportId.replace('#ReportID: ', '')}.png`;
        await bot.sendPhoto(groupId, fs.createReadStream(filename), {
            caption: `🏥 สรุปจำนวนการใช้งานห้องผ่าตัด ปี ${labelText}\n${reportId}`,
        });

        fs.unlinkSync(filename);
    } catch (err) {
        console.error(err);
        await bot.sendMessage(groupId, '❌ ไม่สามารถสร้างกราฟห้องรายปีได้');
    }
}

bot.onText(/\/help/, (msg) => {
    if (msg.chat.id !== groupId) return;

    const status = canProcessCommand('/help');
    if (status === 2) {
        return bot.sendMessage(groupId, '⏳ กรุณารอ 1 นาที ก่อนเรียกดูคำสั่ง /help อีกครั้ง');
    }
    if (status === 3) return;

    const helpText = `
🆘 *รายการคำสั่งทั้งหมด*

📊 สรุปจำนวนการใช้งานห้องผ่าตัด:
• /room – ดูการใช้งานห้องทั้งหมด
• /room เดือน/ปี – ดูการใช้งานห้องแบบรายเดือน (เช่น /room 7/2568)
• /room ปี – ดูการใช้งานห้องแบบรายปี (เช่น /room 2568)

📊 สรุปสถานะการใช้งาน:
• /status – ดูสถานะทั้งหมด
• /status เดือน/ปี – ดูสถานะแบบรายเดือน (เช่น /status 7/2568)
• /status ปี – ดูสถานะแบบรายปี (เช่น /status 2568)

ℹ️ หมายเหตุ:
- ใช้ปี *พ.ศ.* เช่น 2568
- จำกัดการเรียกคำสั่งซ้ำทุก 1 นาที
`.trim();

    bot.sendMessage(groupId, helpText, { parse_mode: 'Markdown' });
});





// === SERVER START ===
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});