const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');

const app = express();

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.PROXY_SECRET || 'n8n-default-secret';

// --- تنظیمات پرفورمنس (High Performance Tuning) ---
// حذف هدر پیش‌فرض اکسپرس برای کاهش حجم پاسخ و امنیت جزئی
app.disable('x-powered-by');

// تنظیمات ایجنت برای مدیریت همزمانی بالا
// نکته: keepAlive را طبق درخواست شما خاموش کردیم تا اتصال به مقصد تازه بماند
const agentOptions = {
    keepAlive: false,       
    maxSockets: Infinity,   // حذف محدودیت تعداد درخواست‌های همزمان
    maxFreeSockets: 50,     // (رزرو برای آینده)
    timeout: 60000          // تایم‌اوت سخت سوکت (۶۰ ثانیه)
};

// ساخت ایجنت‌های اختصاصی که از تنظیمات گلوبال Node.js سریع‌ترند
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

// افزایش حجم بادی برای ریکوئست‌های سنگین
app.use(express.json({ limit: '50mb' })); // افزایش به 50 برای اطمینان
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 1. هندل کردن Health Check (بدون تغییر)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        message: 'Proxy is healthy and ready.',
        concurrency_mode: 'High-Throughput',
        timestamp: new Date().toISOString()
    });
});

// 2. هندل کردن درخواست اصلی پروکسی
app.post('/proxy', async (req, res) => {
    let targetResponse = null;
    
    try {
        const { 
            targetUrl, 
            method = 'GET', 
            headers = {}, 
            params = {}, 
            data = {}, 
            secret 
        } = req.body;

        // بررسی امنیت
        if (secret !== SECRET_KEY) {
            return res.status(403).json({ 
                success: false, 
                error: 'Authentication failed. Invalid Secret Key.' 
            });
        }

        if (!targetUrl) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing targetUrl in request body.' 
            });
        }

        // تنظیمات پیشرفته درخواست
        const axiosConfig = {
            method: method,
            url: targetUrl,
            headers: headers,
            params: params,
            data: data,
            
            // تایم‌اوت هوشمند: کمتر از تایم‌اوت سوکت باشد تا بتوانیم ارور را بگیریم
            timeout: 30000, 
            
            // تزریق ایجنت‌های پرسرعت
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            
            // جلوگیری از فشرده‌سازی خودکار اگر باعث کندی شود (اختیاری، اینجا فعال است)
            decompress: true,

            // مهم: جلوگیری از پرتاب ارور در صورت دریافت کدهای 4xx و 5xx از مقصد
            validateStatus: () => true 
        };

        // ارسال درخواست با حداکثر سرعت
        targetResponse = await axios(axiosConfig);

        // بازگرداندن نتیجه
        res.status(targetResponse.status).json({
            success: true,
            status: targetResponse.status,
            statusText: targetResponse.statusText,
            data: targetResponse.data,
            headers: targetResponse.headers
        });

    } catch (error) {
        // 3. هندل کردن پیشرفته تمام ارورهای احتمالی
        console.error(`Proxy Error [${new Date().toISOString()}]:`, error.message);
        
        let statusCode = 502; // Bad Gateway پیش‌فرض
        let errorType = 'Proxy System Error';

        // تشخیص دقیق نوع خطا برای دیباگ راحت‌تر در n8n
        if (error.code === 'ECONNABORTED') {
            statusCode = 504; // Gateway Timeout
            errorType = 'Timeout Error (Target took too long)';
        } else if (error.code === 'ENOTFOUND') {
            statusCode = 502;
            errorType = 'DNS Error (Target URL not found)';
        } else if (error.code === 'ECONNREFUSED') {
            statusCode = 502;
            errorType = 'Connection Refused (Target is down)';
        }

        // بازگرداندن پاسخ استاندارد JSON حتی در بدترین شرایط
        res.status(statusCode).json({
            success: false,
            status: statusCode,
            error: errorType,
            message: error.message,
            code: error.code || 'UNKNOWN',
            details: error.response?.data || null // اگر دیتایی از سمت سرور خطاکار آمده
        });
    }
});

// جلوگیری از کرش کردن کل برنامه در صورت خطاهای پیش‌بینی نشده
process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR (Uncaught):', err);
    // در محیط پروداکشن واقعی معمولا لاگ می‌گیرند و پروسه را ریستارت می‌کنند
    // اما اینجا برای پایداری سرویس، لاگ می‌کنیم
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// شروع سرور
app.listen(PORT, () => {
    console.log(`High-Performance Proxy Service running on port ${PORT}`);
});