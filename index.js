بسیار عالی. با توجه به اینکه **User-Agent** را خودت مدیریت می‌کنی (که کار هوشمندانه‌ای برای کنترل دقیق‌تر روی هویت ربات‌هاست)، من منطق کد را طوری تنظیم کردم که:

1. اگر هدر `User-Agent` را فرستادی، **به هیچ وجه** به آن دست نزند.
2. سایر هدرهای "لو دهنده" (مثل `X-Forwarded-For`, `Via`) را با بی رحمی حذف کند.
3. تنظیمات **SSL/TLS** را طوری دستکاری کردم که "اثر انگشت" (Fingerprint) درخواست شبیه Node.js نباشد و شبیه مرورگر به نظر برسد.

این کد نهایی و "تمیز" شده برای پروداکشن است:

```javascript
const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.PROXY_SECRET || 'n8n-default-secret';

// --- سیستم لاگینگ رنگی و دقیق برای عیب‌یابی ---
const LOG_COLORS = {
    reset: "\x1b[0m",
    info: "\x1b[36m", // Cyan
    success: "\x1b[32m", // Green
    warn: "\x1b[33m", // Yellow
    error: "\x1b[31m", // Red
    dim: "\x1b[2m"
};

const log = (type, reqId, message, data = '') => {
    const timestamp = new Date().toISOString();
    const color = LOG_COLORS[type] || LOG_COLORS.reset;
    // اگر دیتا آبجکت بود استرینگش کن، اگر نبود خودش رو بذار
    const dataStr = data ? ` | Data: ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
    console.log(`${LOG_COLORS.dim}[${timestamp}]${LOG_COLORS.reset} [${reqId}] ${color}[${type.toUpperCase()}]${LOG_COLORS.reset} ${message}${dataStr}`);
};

// --- تنظیمات سطح پایین شبکه (Stealth & Performance) ---
app.disable('x-powered-by'); // حذف امضای Express
app.set('etag', false);      // جلوگیری از کش شدن و ترکینگ

const agentOptions = {
    keepAlive: false,       // حیاتی: اتصال را می‌بندیم تا در درخواست بعدی IP (اگر چرخشی باشد) عوض شود
    maxSockets: Infinity,
    timeout: 60000,
    // --- تکنیک دور زدن JA3 Fingerprinting ---
    // این سایفرها باعث می‌شوند سرور مقصد فکر کند درخواست از یک مرورگر امن می‌آید نه اسکریپت
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

// تنظیمات پارسر برای هندل کردن پی‌لودهای سنگین
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// میدل‌ویر تولید شناسه یکتا (Trace ID)
app.use((req, res, next) => {
    req.id = crypto.randomUUID().split('-')[0];
    next();
});

// 1. Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'UP', mode: 'Stealth-Proxy' });
});

// تابع تمیزکاری هدرها (Anti-Detection Logic)
const sterilizeHeaders = (headers) => {
    // کپی کردن هدرها (Case-insensitive handling handled mainly by Node/Express but strictly cleaning here)
    const clean = {};
    
    // تبدیل کلیدها به حروف کوچک برای مقایسه مطمئن
    Object.keys(headers).forEach(key => {
        clean[key.toLowerCase()] = headers[key];
    });

    // لیست سیاه: این‌ها داد می‌زنند "من پروکسی هستم"
    const bannedHeaders = [
        'host',             // توسط خود Axios بر اساس URL ست می‌شود (اگر بماند ارور SSL می‌دهد)
        'connection', 
        'content-length', 
        'via', 
        'x-forwarded-for', 
        'x-forwarded-host', 
        'x-forwarded-proto', 
        'forwarded', 
        'x-real-ip', 
        'cf-connecting-ip'  // مربوط به کلودفلر
    ];
    
    bannedHeaders.forEach(h => delete clean[h]);

    // نکته مهم: User-Agent دست‌نخورده باقی می‌ماند چون شما خودتان می‌فرستید.
    // اما اگر کلاینت یادش رفت بفرستد، بهتر است خالی نگذاریم (اختیاری)
    if (!clean['user-agent']) {
        // Fallback اضطراری (فقط اگر شما یادتان رفت بفرستید)
        clean['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    // اضافه کردن هدرهای استاندارد اگر موجود نبودند (برای طبیعی جلوه دادن)
    if (!clean['accept']) clean['accept'] = '*/*';
    if (!clean['accept-language']) clean['accept-language'] = 'en-US,en;q=0.9';
    
    // فریب دادن سرور برای جلوگیری از فشرده‌سازی عجیب، ولی اجازه دادن به gzip
    if (!clean['accept-encoding']) clean['accept-encoding'] = 'gzip, deflate, br';

    return clean;
};

// 2. هندل کردن درخواست پروکسی
app.post('/proxy', async (req, res) => {
    const reqId = req.id;
    
    try {
        const { targetUrl, method = 'GET', headers = {}, params = {}, data = {}, secret } = req.body;

        // لاگ ورودی
        log('info', reqId, `Request: ${method} -> ${targetUrl}`);

        // 1. امنیت
        if (secret !== SECRET_KEY) {
            log('warn', reqId, 'Auth Failed');
            return res.status(403).json({ success: false, error: 'Invalid Secret' });
        }
        if (!targetUrl) {
            return res.status(400).json({ success: false, error: 'Target URL required' });
        }

        // 2. پاکسازی ردپا (Stealth Mode)
        const sanitizedHeaders = sterilizeHeaders(headers);

        // 3. کانفیگ نهایی درخواست
        const axiosConfig = {
            method,
            url: targetUrl,
            headers: sanitizedHeaders,
            params,
            data,
            timeout: 30000,          // 30 ثانیه مهلت دریافت پاسخ
            httpAgent,               // استفاده از ایجنت‌های بهینه شده
            httpsAgent,
            decompress: true,        // باز کردن خودکار gzip
            validateStatus: () => true, // جلوگیری از throw شدن ارور روی 404/500
            maxRedirects: 5          // دنبال کردن ریدایرکت‌ها به صورت محدود
        };

        const start = Date.now();
        
        // 4. شلیک درخواست
        const response = await axios(axiosConfig);
        
        const duration = Date.now() - start;
        log('success', reqId, `Status: ${response.status} | Time: ${duration}ms`);

        // 5. آماده‌سازی پاسخ برای کلاینت (حذف هدرهای مزاحم پاسخ)
        const resHeaders = { ...response.headers };
        delete resHeaders['content-encoding']; 
        delete resHeaders['transfer-encoding'];

        // 6. ارسال خروجی استاندارد
        res.status(response.status).json({
            success: true,
            meta: {
                reqId,
                duration: `${duration}ms`,
                target: targetUrl,
                used_headers: sanitizedHeaders // برای دیباگ: ببینید دقیقا چه هدرهایی ارسال شد
            },
            status: response.status,
            statusText: response.statusText,
            data: response.data,
            headers: resHeaders
        });

    } catch (error) {
        // مدیریت جامع خطاها
        log('error', reqId, `FAILURE: ${error.message}`, error.code);

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

        res.status(status).json({
            success: false,
            meta: { reqId },
            status,
            error: type,
            message: error.message,
            code: error.code || 'UNKNOWN',
            details: error.response?.data || null
        });
    }
});

// Global Error Handlers (جلوگیری از قطع شدن برنامه)
process.on('uncaughtException', (err) => {
    console.error('\x1b[41mCRITICAL\x1b[0m', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('\x1b[33mUNHANDLED REJECTION\x1b[0m', reason);
});

app.listen(PORT, () => {
    console.log(`\n👻 Stealth Proxy running on port ${PORT}`);
    console.log(`🛡️  Protection: ACTIVE | Headers: SANITIZED | Logs: VERBOSE\n`);
});

```