const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.PROXY_SECRET || 'n8n-default-secret';

// افزایش حجم بادی برای ریکوئست‌های سنگین
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 1. هندل کردن Health Check (بررسی سلامت سرور)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        message: 'Proxy is healthy and ready.',
        timestamp: new Date().toISOString()
    });
});

// 2. هندل کردن درخواست اصلی پروکسی
app.post('/proxy', async (req, res) => {
    // مقداردهی اولیه برای پاسخ
    let targetResponse = null;
    
    try {
        const { 
            targetUrl, 
            method = 'GET', 
            headers = {}, 
            params = {}, // برای Query Params
            data = {},   // برای Body
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

        // تنظیمات درخواست به مقصد
        const axiosConfig = {
            method: method,
            url: targetUrl,
            headers: headers,
            params: params, // پشتیبانی از کوئری پارامترها مثل ?id=123
            data: data,     // پشتیبانی از JSON Body
            timeout: 30000, // تایم اوت ۳۰ ثانیه برای جلوگیری از فریز شدن
            
            // مهم: جلوگیری از پرتاب ارور در صورت دریافت کدهای 4xx و 5xx از مقصد
            validateStatus: function (status) {
                return true; 
            }
        };

        // ارسال درخواست
        targetResponse = await axios(axiosConfig);

        // بازگرداندن نتیجه دقیقاً همانطور که هست
        // ما هدرهای پاسخ مقصد را هم برمی‌گردانیم شاید در n8n نیاز داشته باشید
        res.status(targetResponse.status).json({
            success: true,
            status: targetResponse.status,
            statusText: targetResponse.statusText,
            data: targetResponse.data,
            headers: targetResponse.headers
        });

    } catch (error) {
        // 3. هندل کردن خطاهای سیستمی (مثل قطعی اینترنت سرور، اشتباه بودن آدرس و ...)
        console.error('System Error:', error.message);
        
        // این بخش تضمین می‌کند n8n همیشه جواب JSON بگیرد حتی اگر درخواست فیل شود
        res.status(502).json({
            success: false,
            status: 502,
            error: 'Proxy System Error',
            message: error.message,
            code: error.code || 'UNKNOWN_ERROR'
        });
    }
});

// شروع سرور
app.listen(PORT, () => {
    console.log(`Robust Proxy Service running on port ${PORT}`);
});