const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.PROXY_SECRET || 'n8n-default-secret';

// --- ابزار لاگ‌برداری ایمن (Fix: جلوگیری از کرش کردن روی آبجکت‌های حلقوی) ---
const LOG_COLORS = {
    reset: "\x1b[0m",
    info: "\x1b[36m",
    success: "\x1b[32m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
    dim: "\x1b[2m"
};

// تابع ایمن برای تبدیل آبجکت به استرینگ (جلوگیری از خطای Circular Structure)
const safeStringify = (obj) => {
    const cache = new Set();
    return JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
            if (cache.has(value)) {
                // حذف ارجاع حلقوی
                return '[Circular]';
            }
            cache.add(value);
        }
        return value;
    });
};

const log = (type, reqId, message, data = null) => {
    try {
        const timestamp = new Date().toISOString();
        const color = LOG_COLORS[type] || LOG_COLORS.reset;
        let dataStr = '';
        
        if (data) {
            // اگر دیتا آبجکت خطا بود، فقط مسیج و کد را بردار تا لاگ شلوغ و خطرناک نشود
            if (data instanceof Error) {
                dataStr = ` | Error: ${data.message} [${data.code || 'NO_CODE'}]`;
            } else if (typeof data === 'object') {
                // استفاده از استرینگ‌ساز ایمن
                try {
                    dataStr = ` | Data: ${safeStringify(data)}`;
                } catch (e) {
                    dataStr = ` | Data: [Log Error]`;
                }
            } else {
                dataStr = ` | Data: ${data}`;
            }
        }
        
        console.log(`${LOG_COLORS.dim}[${timestamp}]${LOG_COLORS.reset} [${reqId || 'SYSTEM'}] ${color}[${type.toUpperCase()}]${LOG_COLORS.reset} ${message}${dataStr}`);
    } catch (e) {
        // اگر خود لاگر خطا داد، نباید برنامه بخوابد
        console.error('FATAL LOGGING ERROR:', e);
    }
};

// --- تنظیمات سطح پایین شبکه ---
app.disable('x-powered-by');
app.set('etag', false);

const agentOptions = {
    keepAlive: false,
    maxSockets: Infinity,
    timeout: 60000,
    ciphers: [
        'TLS_AES_128_GCM_SHA256',
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384',
    ].join(':'),
    honorCipherOrder: true,
    minVersion: 'TLSv1.2'
};

const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- میدل‌ویر تولید شناسه (Fix: سازگار با تمام نسخه‌های Node) ---
app.use((req, res, next) => {
    // استفاده از randomBytes که در تمام نسخه‌ها هست، بجای randomUUID که شاید نباشد
    req.id = crypto.randomBytes(4).toString('hex');
    next();
});

// 1. Health Check
app.get('/health', (req, res) => {
    // لاگ ساده بدون ارسال آبجکت پیچیده
    log('info', req.id, 'Health check requested');
    res.status(200).json({ status: 'UP', mode: 'Stealth-Proxy-Stable' });
});

// تابع تمیزکاری هدرها
const sterilizeHeaders = (headers) => {
    const clean = {};
    if (!headers) return clean; // گارد برای هدر خالی

    Object.keys(headers).forEach(key => {
        clean[key.toLowerCase()] = headers[key];
    });

    const bannedHeaders = [
        'host', 'connection', 'content-length', 'via', 
        'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 
        'forwarded', 'x-real-ip', 'cf-connecting-ip'
    ];
    
    bannedHeaders.forEach(h => delete clean[h]);

    if (!clean['user-agent']) {
        clean['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    if (!clean['accept']) clean['accept'] = '*/*';
    if (!clean['accept-language']) clean['accept-language'] = 'en-US,en;q=0.9';
    if (!clean['accept-encoding']) clean['accept-encoding'] = 'gzip, deflate, br';

    return clean;
};

// 2. هندل کردن درخواست پروکسی
app.post('/proxy', async (req, res) => {
    const reqId = req.id;
    
    try {
        const { targetUrl, method = 'GET', headers = {}, params = {}, data = {}, secret } = req.body;

        log('info', reqId, `Request: ${method} -> ${targetUrl}`);

        if (secret !== SECRET_KEY) {
            log('warn', reqId, 'Auth Failed');
            return res.status(403).json({ success: false, error: 'Invalid Secret' });
        }
        if (!targetUrl) {
            return res.status(400).json({ success: false, error: 'Target URL required' });
        }

        const sanitizedHeaders = sterilizeHeaders(headers);

        const axiosConfig = {
            method,
            url: targetUrl,
            headers: sanitizedHeaders,
            params,
            data,
            timeout: 30000,
            httpAgent,
            httpsAgent,
            decompress: true,
            validateStatus: () => true,
            maxRedirects: 5
        };

        const start = Date.now();
        const response = await axios(axiosConfig);
        const duration = Date.now() - start;

        log('success', reqId, `Status: ${response.status} | Time: ${duration}ms`);

        const resHeaders = { ...response.headers };
        delete resHeaders['content-encoding']; 
        delete resHeaders['transfer-encoding'];

        res.status(response.status).json({
            success: true,
            meta: {
                reqId,
                duration: `${duration}ms`,
                target: targetUrl
            },
            status: response.status,
            statusText: response.statusText,
            data: response.data,
            headers: resHeaders
        });

    } catch (error) {
        // لاگ کردن فقط مسیج ارور برای جلوگیری از کرش حلقوی
        log('error', reqId, `FAILURE: ${error.message}`, error);

        let status = 502;
        let type = 'Proxy Error';

        if (error.code === 'ECONNABORTED') {
            status = 504;
            type = 'Timeout';
        } else if (error.code === 'ENOTFOUND') {
            type = 'DNS Failed';
        } else if (error.code === 'ECONNREFUSED') {
            type = 'Target Down';
        }

        // بررسی اینکه آیا هدرها قبلا ارسال شده‌اند یا خیر (جلوگیری از کرش مضاعف)
        if (!res.headersSent) {
            res.status(status).json({
                success: false,
                meta: { reqId },
                status,
                error: type,
                message: error.message,
                code: error.code || 'UNKNOWN'
            });
        }
    }
});

// --- FIX حیاتی: هندلر نهایی خطاها (Global Error Handler) ---
// اگر خطایی در میدل‌ورها یا بخش‌های سینکرون رخ دهد، اکسپرس اینجا آن را می‌گیرد
// و از کرش کردن پاد جلوگیری می‌کند.
app.use((err, req, res, next) => {
    console.error(`\x1b[31m[CRITICAL HANDLER]\x1b[0m Exception caught in request ${req.id || 'Unknown'}:`, err.message);
    if (!res.headersSent) {
        res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            message: 'An unexpected error occurred but the pod remained stable.'
        });
    }
});

// جلوگیری از خروج ناگهانی پروسه
process.on('uncaughtException', (err) => {
    console.error('\x1b[41mCRITICAL (Uncaught)\x1b[0m', err.message);
    // پروسه را زنده نگه می‌داریم
});

process.on('unhandledRejection', (reason) => {
    console.error('\x1b[33mUNHANDLED REJECTION\x1b[0m', reason);
});

app.listen(PORT, () => {
    console.log(`\n🚑 Stable-Stealth Proxy running on port ${PORT}`);
    console.log(`🛡️  Fixes Applied: Safe Logging, Compatible Crypto, Global Error Handler\n`);
});