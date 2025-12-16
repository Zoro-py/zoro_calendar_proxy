const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const dns = require('dns'); // اضافه شده برای تیونینگ شبکه

// تنظیم DNS های سریع برای جلوگیری از تاخیر ریسالو در دیتاسنتر
dns.setServers(['1.1.1.1', '8.8.8.8']);

const app = express();

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.PROXY_SECRET || 'n8n-default-secret';

// --- ابزار لاگ‌برداری ایمن ---
const LOG_COLORS = {
    reset: "\x1b[0m",
    info: "\x1b[36m",
    success: "\x1b[32m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
    dim: "\x1b[2m"
};

// تابع ایمن برای تبدیل آبجکت به استرینگ
const safeStringify = (obj) => {
    const cache = new Set();
    return JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
            if (cache.has(value)) {
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
            if (data instanceof Error) {
                dataStr = ` | Error: ${data.message} [${data.code || 'NO_CODE'}]`;
            } else if (typeof data === 'object') {
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
        console.error('FATAL LOGGING ERROR:', e);
    }
};

// --- تنظیمات سطح پایین شبکه ---
app.disable('x-powered-by');
app.set('etag', false);

const agentOptions = {
    keepAlive: false, // خاموش ماندن برای امنیت و چرخش IP در سمت مقصد
    maxSockets: Infinity,
    timeout: 60000,
    
    // --- پرفورمنس: اجبار به استفاده از IPv4 برای حذف تاخیر دیتاسنتر ---
    family: 4, 
    
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

// --- میدل‌ویر تولید شناسه ---
app.use((req, res, next) => {
    req.id = crypto.randomBytes(4).toString('hex');
    next();
});

// 1. Health Check
app.get('/health', (req, res) => {
    log('info', req.id, 'Health check requested');
    res.status(200).json({ status: 'UP', mode: 'Stealth-Optimized' });
});

// تابع تمیزکاری هدرها
const sterilizeHeaders = (headers) => {
    const clean = {};
    if (!headers) return clean;

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
    const startTotal = Date.now(); // ثبت زمان ورود درخواست به سیستم
    
    try {
        const { targetUrl, method = 'GET', headers = {}, params = {}, data = {}, secret } = req.body;

        // log('info', reqId, `Request: ${method} -> ${targetUrl}`); // برای افزایش سرعت لاگ اینفو را میتوانید کامنت کنید

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

        // --- پرفورمنس: باز نگه داشتن کانکشن n8n ---
        res.set('Connection', 'keep-alive');
        res.set('Keep-Alive', 'timeout=60'); 

        res.status(response.status).json({
            success: true,
            meta: {
                reqId,
                duration: `${duration}ms`,
                total_process: `${Date.now() - startTotal}ms`, // زمان کل پردازش
                target: targetUrl
            },
            status: response.status,
            statusText: response.statusText,
            data: response.data,
            headers: resHeaders
        });

    } catch (error) {
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

// --- هندلر نهایی خطاها ---
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

process.on('uncaughtException', (err) => {
    console.error('\x1b[41mCRITICAL (Uncaught)\x1b[0m', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('\x1b[33mUNHANDLED REJECTION\x1b[0m', reason);
});

// --- شروع سرور با تنظیمات Keep-Alive ---
const server = app.listen(PORT, () => {
    console.log(`\n🚀 Optimized Stealth Proxy running on port ${PORT}`);
    console.log(`⚡ Performance: IPv4 Forced | Upstream Keep-Alive Enabled\n`);
});

// افزایش تایم‌اوت سوکت برای جلوگیری از قطع اتصال توسط نود جی‌اس
// این عدد باید کمی بیشتر از تایم‌اوت HTTP Request در n8n باشد
server.keepAliveTimeout = 65000; 
server.headersTimeout = 66000;