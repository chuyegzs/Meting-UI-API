import api from './src/service/api.js'
import { handler } from './src/template.js'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import config from './src/config.js'
import { get_runtime, get_url } from './src/util.js'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

const app = new Hono()

const STATS_FILE = './stats.json'
const BACKUP_DIR = './backups'

let apiStats = {
    totalCalls: 0,
    dailyCalls: {},
    hourlyCalls: {},
    weeklyCalls: {},
    monthlyCalls: {},
    lastUpdated: new Date().toISOString(),
    lastResetDate: new Date().toISOString().split('T')[0],
    lastWeeklyReset: new Date().toISOString().split('T')[0],
    lastMonthlyReset: new Date().toISOString().split('T')[0].slice(0, 7)
};

let useMySQL = false;
let dbPool = null;

let mysql;
try {
    mysql = (await import('mysql2/promise')).default;
    console.log('✅ MySQL2 模块加载成功');
} catch (error) {
    console.log('ℹ️  MySQL2 模块未安装，将使用本地文件存储');
}

let DB_CONFIG;
try {
    DB_CONFIG = (await import('./mysql.js')).default;
    console.log('✅ 从mysql.js加载数据库配置');
} catch (error) {
    console.log('ℹ️  未找到mysql.js配置文件，使用环境变量配置');
    DB_CONFIG = {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'api_stats',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        charset: 'utf8mb4'
    };
}

const isVercel = process.env.VERCEL || process.env.VERCEL_ENV || process.env.NEXT_PUBLIC_VERCEL_ENV;

const getBeijingDate = () => {
    const now = new Date();
    return new Date(now.getTime() + 8 * 60 * 60 * 1000);
};

const getBeijingDateString = () => {
    return getBeijingDate().toISOString().split('T')[0];
};

const getBeijingHour = () => {
    return getBeijingDate().getUTCHours();
};

const getWeekNumber = (date) => {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
};

const getWeekKey = () => {
    const beijingDate = getBeijingDate();
    const year = beijingDate.getFullYear();
    const week = getWeekNumber(beijingDate);
    return `${year}-W${week.toString().padStart(2, '0')}`;
};

const getMonthKey = () => {
    const beijingDate = getBeijingDate();
    const year = beijingDate.getFullYear();
    const month = beijingDate.getMonth() + 1;
    return `${year}-${month.toString().padStart(2, '0')}`;
};

const cleanupOldBackups = async () => {
    try {
        if (!existsSync(BACKUP_DIR)) {
            return;
        }

        const files = await fs.readdir(BACKUP_DIR);
        const backupFiles = files.filter(file => file.startsWith('stats-backup-') && file.endsWith('.json'));
        
        if (backupFiles.length <= 3) {
            return;
        }

        const filesWithStats = await Promise.all(
            backupFiles.map(async file => {
                const filePath = path.join(BACKUP_DIR, file);
                const stats = await fs.stat(filePath);
                return { file, mtime: stats.mtime.getTime() };
            })
        );

        filesWithStats.sort((a, b) => a.mtime - b.mtime);

        const filesToDelete = filesWithStats.slice(0, filesWithStats.length - 3);
        
        for (const fileInfo of filesToDelete) {
            const filePath = path.join(BACKUP_DIR, fileInfo.file);
            await fs.unlink(filePath);
            console.log(`🗑️  删除旧备份文件: ${fileInfo.file}`);
        }
    } catch (error) {
        console.error('❌ 清理旧备份失败:', error);
    }
};

const createBackup = async () => {
    try {
        if (!existsSync(BACKUP_DIR)) {
            await fs.mkdir(BACKUP_DIR, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(BACKUP_DIR, `stats-backup-${timestamp}.json`);
        
        await fs.writeFile(backupFile, JSON.stringify(apiStats, null, 2), 'utf8');
        console.log(`📦 创建备份文件: ${backupFile}`);
        
        await cleanupOldBackups();
        
        return backupFile;
    } catch (error) {
        console.error('❌ 创建备份失败:', error);
        return null;
    }
};

const initMySQL = async () => {
    if (!mysql) {
        console.log('ℹ️  MySQL2模块不可用，使用本地文件存储');
        return false;
    }

    const hasDBConfig = DB_CONFIG.host && DB_CONFIG.user && DB_CONFIG.database;
    
    if (!hasDBConfig || DB_CONFIG.host === 'localhost' && DB_CONFIG.user === 'root' && !DB_CONFIG.password) {
        console.log('ℹ️  未配置数据库连接信息或使用默认配置，使用本地文件存储');
        return false;
    }

    try {
        console.log('🔗 尝试连接数据库...', {
            host: DB_CONFIG.host,
            port: DB_CONFIG.port,
            database: DB_CONFIG.database,
            user: DB_CONFIG.user
        });
        
        dbPool = mysql.createPool(DB_CONFIG);
        
        const connection = await dbPool.getConnection();
        console.log('✅ 数据库连接成功');
        connection.release();

        await initDatabaseTables();
        useMySQL = true;
        console.log('💾 已启用数据库存储');
        return true;
    } catch (error) {
        console.error('❌ 数据库连接失败:', error.message);
        if (dbPool) {
            await dbPool.end();
            dbPool = null;
        }
        return false;
    }
};

const initDatabaseTables = async () => {
    if (!dbPool) return;

    try {
        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS api_statistics (
                id INT AUTO_INCREMENT PRIMARY KEY,
                stat_key VARCHAR(100) UNIQUE NOT NULL,
                stat_value JSON,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        
        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS api_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                endpoint VARCHAR(255) NOT NULL,
                method VARCHAR(10) NOT NULL,
                status_code INT NOT NULL,
                response_time_ms INT NOT NULL,
                ip_address VARCHAR(45),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_endpoint (endpoint),
                INDEX idx_created_at (created_at),
                INDEX idx_status_code (status_code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        
        console.log('✅ 数据库表初始化完成');
    } catch (error) {
        console.error('❌ 数据库表初始化失败:', error);
        throw error;
    }
};

const dbOperations = {
    loadStats: async () => {
        if (!dbPool) return null;

        try {
            const [totalRows] = await dbPool.execute(
                'SELECT stat_value FROM api_statistics WHERE stat_key = ?',
                ['total_calls']
            );
            const [dailyRows] = await dbPool.execute(
                'SELECT stat_value FROM api_statistics WHERE stat_key = ?',
                ['daily_calls']
            );
            const [hourlyRows] = await dbPool.execute(
                'SELECT stat_value FROM api_statistics WHERE stat_key = ?',
                ['hourly_calls']
            );
            const [weeklyRows] = await dbPool.execute(
                'SELECT stat_value FROM api_statistics WHERE stat_key = ?',
                ['weekly_calls']
            );
            const [monthlyRows] = await dbPool.execute(
                'SELECT stat_value FROM api_statistics WHERE stat_key = ?',
                ['monthly_calls']
            );
            const [metaRows] = await dbPool.execute(
                'SELECT stat_value FROM api_statistics WHERE stat_key = ?',
                ['metadata']
            );

            const total = totalRows[0]?.stat_value;
            const daily = dailyRows[0]?.stat_value;
            const hourly = hourlyRows[0]?.stat_value;
            const weekly = weeklyRows[0]?.stat_value;
            const monthly = monthlyRows[0]?.stat_value;
            const meta = metaRows[0]?.stat_value;

            return {
                totalCalls: total ? (typeof total === 'string' ? JSON.parse(total).totalCalls : total.totalCalls) || 0 : 0,
                dailyCalls: daily ? (typeof daily === 'string' ? JSON.parse(daily) : daily) : {},
                hourlyCalls: hourly ? (typeof hourly === 'string' ? JSON.parse(hourly) : hourly) : {},
                weeklyCalls: weekly ? (typeof weekly === 'string' ? JSON.parse(weekly) : weekly) : {},
                monthlyCalls: monthly ? (typeof monthly === 'string' ? JSON.parse(monthly) : monthly) : {},
                lastUpdated: meta ? (typeof meta === 'string' ? JSON.parse(meta).lastUpdated : meta.lastUpdated) || new Date().toISOString() : new Date().toISOString(),
                lastResetDate: meta ? (typeof meta === 'string' ? JSON.parse(meta).lastResetDate : meta.lastResetDate) || getBeijingDateString() : getBeijingDateString(),
                lastWeeklyReset: meta ? (typeof meta === 'string' ? JSON.parse(meta).lastWeeklyReset : meta.lastWeeklyReset) || getBeijingDateString() : getBeijingDateString(),
                lastMonthlyReset: meta ? (typeof meta === 'string' ? JSON.parse(meta).lastMonthlyReset : meta.lastMonthlyReset) || getBeijingDateString().slice(0, 7) : getBeijingDateString().slice(0, 7)
            };
        } catch (error) {
            console.error('❌ 从数据库加载统计数据失败:', error);
            return null;
        }
    },

    saveStats: async () => {
        if (!dbPool) return false;

        try {
            const now = new Date().toISOString();
            const metadata = {
                lastUpdated: now,
                lastResetDate: apiStats.lastResetDate,
                lastWeeklyReset: apiStats.lastWeeklyReset,
                lastMonthlyReset: apiStats.lastMonthlyReset
            };

            const queries = [
                ['total_calls', JSON.stringify({ totalCalls: apiStats.totalCalls })],
                ['daily_calls', JSON.stringify(apiStats.dailyCalls)],
                ['hourly_calls', JSON.stringify(apiStats.hourlyCalls)],
                ['weekly_calls', JSON.stringify(apiStats.weeklyCalls)],
                ['monthly_calls', JSON.stringify(apiStats.monthlyCalls)],
                ['metadata', JSON.stringify(metadata)]
            ];

            for (const [key, value] of queries) {
                await dbPool.execute(
                    `INSERT INTO api_statistics (stat_key, stat_value) 
                     VALUES (?, ?) 
                     ON DUPLICATE KEY UPDATE stat_value = ?, updated_at = CURRENT_TIMESTAMP`,
                    [key, value, value]
                );
            }

            console.log('💾 统计数据已保存到数据库');
            return true;
        } catch (error) {
            console.error('❌ 保存统计数据到数据库失败:', error);
            return false;
        }
    },

    logApiRequest: async (endpoint, method, statusCode, responseTime, ip, userAgent) => {
        if (!dbPool) return;
        
        try {
            await dbPool.execute(
                'INSERT INTO api_logs (endpoint, method, status_code, response_time_ms, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
                [endpoint, method, statusCode, responseTime, ip, userAgent]
            );
        } catch (error) {
            console.error('❌ 记录API日志失败:', error);
        }
    },

    getAnalytics: async () => {
        if (!dbPool) return null;
        
        try {
            const [topEndpoints] = await dbPool.execute(
                'SELECT endpoint, COUNT(*) as count FROM api_logs GROUP BY endpoint ORDER BY count DESC LIMIT 10'
            );
            
            const [statusCodes] = await dbPool.execute(
                'SELECT status_code, COUNT(*) as count FROM api_logs GROUP BY status_code ORDER BY count DESC'
            );
            
            const [responseTimes] = await dbPool.execute(
                'SELECT AVG(response_time_ms) as avg_time, MIN(response_time_ms) as min_time, MAX(response_time_ms) as max_time FROM api_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)'
            );
            
            const [hourlyActivity] = await dbPool.execute(
                'SELECT HOUR(created_at) as hour, COUNT(*) as count FROM api_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) GROUP BY HOUR(created_at) ORDER BY hour'
            );
            
            return {
                topEndpoints,
                statusCodes,
                responseTimes: responseTimes[0] || {},
                hourlyActivity
            };
        } catch (error) {
            console.error('❌ 获取分析数据失败:', error);
            return null;
        }
    }
};

const fileOperations = {
    loadStats: async () => {
        if (!existsSync(STATS_FILE)) return null;
        
        try {
            const data = await fs.readFile(STATS_FILE, 'utf8');
            const savedStats = JSON.parse(data);
            return {
                totalCalls: savedStats.totalCalls || 0,
                dailyCalls: savedStats.dailyCalls || {},
                hourlyCalls: savedStats.hourlyCalls || {},
                weeklyCalls: savedStats.weeklyCalls || {},
                monthlyCalls: savedStats.monthlyCalls || {},
                lastUpdated: savedStats.lastUpdated || new Date().toISOString(),
                lastResetDate: savedStats.lastResetDate || getBeijingDateString(),
                lastWeeklyReset: savedStats.lastWeeklyReset || getBeijingDateString(),
                lastMonthlyReset: savedStats.lastMonthlyReset || getBeijingDateString().slice(0, 7)
            };
        } catch (error) {
            console.error('❌ 从本地文件加载统计数据失败:', error);
            return null;
        }
    },

    saveStats: async () => {
        try {
            await fs.writeFile(STATS_FILE, JSON.stringify(apiStats, null, 2), 'utf8');
            console.log('💾 统计数据已保存到本地文件');
            return true;
        } catch (error) {
            console.error('❌ 保存统计数据到本地文件失败:', error);
            return false;
        }
    }
};

const migrateFromFileToDB = async () => {
    if (!dbPool || !existsSync(STATS_FILE)) return;

    try {
        console.log('🔄 开始从本地文件迁移数据到数据库...');
        const fileData = await fileOperations.loadStats();
        
        if (fileData) {
            apiStats.totalCalls = Math.max(apiStats.totalCalls, fileData.totalCalls);
            
            Object.keys(fileData.dailyCalls || {}).forEach(date => {
                const fileCount = fileData.dailyCalls[date] || 0;
                const dbCount = apiStats.dailyCalls[date] || 0;
                apiStats.dailyCalls[date] = Math.max(fileCount, dbCount);
            });

            Object.keys(fileData.hourlyCalls || {}).forEach(key => {
                const fileCount = fileData.hourlyCalls[key] || 0;
                const dbCount = apiStats.hourlyCalls[key] || 0;
                apiStats.hourlyCalls[key] = Math.max(fileCount, dbCount);
            });

            Object.keys(fileData.weeklyCalls || {}).forEach(key => {
                const fileCount = fileData.weeklyCalls[key] || 0;
                const dbCount = apiStats.weeklyCalls[key] || 0;
                apiStats.weeklyCalls[key] = Math.max(fileCount, dbCount);
            });

            Object.keys(fileData.monthlyCalls || {}).forEach(key => {
                const fileCount = fileData.monthlyCalls[key] || 0;
                const dbCount = apiStats.monthlyCalls[key] || 0;
                apiStats.monthlyCalls[key] = Math.max(fileCount, dbCount);
            });

            await dbOperations.saveStats();
            
            console.log('✅ 数据迁移完成');
        }
    } catch (error) {
        console.error('❌ 数据迁移失败:', error);
    }
};

const cleanupOldData = () => {
    const today = getBeijingDateString();
    
    const ninetyDaysAgo = getBeijingDate();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const ninetyDaysAgoStr = ninetyDaysAgo.toISOString().split('T')[0];
    
    Object.keys(apiStats.dailyCalls).forEach(date => {
        if (date < ninetyDaysAgoStr) {
            delete apiStats.dailyCalls[date];
        }
    });
    
    const sevenDaysAgo = getBeijingDate();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];
    
    Object.keys(apiStats.hourlyCalls).forEach(key => {
        const date = key.split('-')[0];
        if (date < sevenDaysAgoStr) {
            delete apiStats.hourlyCalls[key];
        }
    });
    
    const currentYear = new Date().getFullYear();
    Object.keys(apiStats.weeklyCalls).forEach(weekKey => {
        const year = parseInt(weekKey.split('-')[0]);
        if (year < currentYear - 1) {
            delete apiStats.weeklyCalls[weekKey];
        }
    });
    
    Object.keys(apiStats.monthlyCalls).forEach(monthKey => {
        const year = parseInt(monthKey.split('-')[0]);
        if (year < currentYear - 2) {
            delete apiStats.monthlyCalls[monthKey];
        }
    });
};

const checkAndResetStats = async () => {
    const today = getBeijingDateString();
    const weekKey = getWeekKey();
    const monthKey = getMonthKey();
    
    console.log(`🔍 检查重置: 日期=${today}, 周=${weekKey}, 月=${monthKey}`);
    console.log(`📊 上次重置: 日=${apiStats.lastResetDate}, 周=${apiStats.lastWeeklyReset}, 月=${apiStats.lastMonthlyReset}`);
    
    let resetHappened = false;
    
    if (today !== apiStats.lastResetDate) {
        console.log(`🔄 日期已变化！重置今日统计：${apiStats.lastResetDate} -> ${today}`);
        
        await createBackup();
        
        apiStats.lastResetDate = today;
        apiStats.dailyCalls[today] = 0;
        
        resetHappened = true;
    }
    
    const currentWeekStart = getWeekKey();
    if (currentWeekStart !== apiStats.lastWeeklyReset) {
        console.log(`🔄 周已变化！重置本周统计：${apiStats.lastWeeklyReset} -> ${currentWeekStart}`);
        
        apiStats.lastWeeklyReset = currentWeekStart;
        apiStats.weeklyCalls[currentWeekStart] = 0;
        
        resetHappened = true;
    }
    
    const currentMonth = getMonthKey();
    if (currentMonth !== apiStats.lastMonthlyReset) {
        console.log(`🔄 月已变化！重置本月统计：${apiStats.lastMonthlyReset} -> ${currentMonth}`);
        
        apiStats.lastMonthlyReset = currentMonth;
        apiStats.monthlyCalls[currentMonth] = 0;
        
        resetHappened = true;
    }
    
    if (resetHappened) {
        cleanupOldData();
        await saveStats();
        console.log('✅ 统计重置完成');
    }
    
    return resetHappened;
};

const loadStats = async () => {
    try {
        if (isVercel) {
            console.log(`📊 当前统计：总调用=${apiStats.totalCalls}, 上次重置=${apiStats.lastResetDate}`);
            return;
        }
        
        const mysqlEnabled = await initMySQL();
        
        if (mysqlEnabled) {
            const dbStats = await dbOperations.loadStats();
            if (dbStats) {
                Object.assign(apiStats, dbStats);
                console.log('✅ 从数据库加载统计数据成功');
                
                if (existsSync(STATS_FILE)) {
                    await migrateFromFileToDB();
                }
            }
        } else {
            const fileStats = await fileOperations.loadStats();
            if (fileStats) {
                Object.assign(apiStats, fileStats);
                console.log('✅ 从本地文件加载统计数据成功');
            }
        }
        
        console.log(`📊 当前统计：总调用=${apiStats.totalCalls}, 今日=${apiStats.dailyCalls[getBeijingDateString()] || 0}`);
        
        const resetHappened = await checkAndResetStats();
        if (resetHappened) {
            console.log('🔄 启动时检测到日期变化，统计已更新');
        }
    } catch (error) {
        console.error('❌ 加载统计数据失败:', error);
        console.log('📝 创建新的统计数据');
        await saveStats();
    }
};

const saveStats = async () => {
    try {
        apiStats.lastUpdated = new Date().toISOString();
        
        if (isVercel) {
            console.log('📝 Vercel环境：统计数据仅在内存中（重启丢失）');
            return;
        }
        
        if (useMySQL && dbPool) {
            await dbOperations.saveStats();
        } else {
            await fileOperations.saveStats();
        }
        
        if (apiStats.totalCalls % 1000 === 0) {
            await createBackup();
        }
    } catch (error) {
        console.error('❌ 保存统计数据失败:', error);
    }
};

const updateStats = async () => {
    const today = getBeijingDateString();
    const hour = getBeijingHour();
    const weekKey = getWeekKey();
    const monthKey = getMonthKey();
    
    console.log(`📝 更新统计: 日期=${today}, 小时=${hour}, 周=${weekKey}, 月=${monthKey}`);
    
    await checkAndResetStats();
    
    apiStats.totalCalls++;
    apiStats.dailyCalls[today] = (apiStats.dailyCalls[today] || 0) + 1;
    
    const hourKey = `${today}-${hour}`;
    apiStats.hourlyCalls[hourKey] = (apiStats.hourlyCalls[hourKey] || 0) + 1;
    
    apiStats.weeklyCalls[weekKey] = (apiStats.weeklyCalls[weekKey] || 0) + 1;
    apiStats.monthlyCalls[monthKey] = (apiStats.monthlyCalls[monthKey] || 0) + 1;
    
    await saveStats();
    
    return apiStats;
};

const getTodayCalls = () => {
    return apiStats.dailyCalls[getBeijingDateString()] || 0;
};

const getWeekCalls = () => {
    const weekKey = getWeekKey();
    return apiStats.weeklyCalls[weekKey] || 0;
};

const getMonthCalls = () => {
    const monthKey = getMonthKey();
    return apiStats.monthlyCalls[monthKey] || 0;
};

const getNextResetTime = () => {
    const now = getBeijingDate();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const timeDiff = tomorrow.getTime() - now.getTime();
    const hours = Math.floor(timeDiff / (1000 * 60 * 60));
    const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((timeDiff % (1000 * 60)) / 1000);
    
    const timeStr = tomorrow.toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    
    return {
        time: timeStr,
        hours,
        minutes,
        seconds,
        formatted: `${hours}小时${minutes}分${seconds}秒后`
    };
};

const getNextWeeklyReset = () => {
    const now = getBeijingDate();
    const nextMonday = new Date(now);
    const daysUntilMonday = (8 - now.getDay()) % 7;
    nextMonday.setDate(now.getDate() + (daysUntilMonday === 0 ? 7 : daysUntilMonday));
    nextMonday.setHours(0, 0, 0, 0);
    
    const timeDiff = nextMonday.getTime() - now.getTime();
    const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    return {
        time: nextMonday.toLocaleString('zh-CN', { 
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long'
        }),
        days,
        hours,
        formatted: days > 0 ? `${days}天${hours}小时后` : `${hours}小时后`
    };
};

const getNextMonthlyReset = () => {
    const now = getBeijingDate();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    nextMonth.setHours(0, 0, 0, 0);
    
    const timeDiff = nextMonth.getTime() - now.getTime();
    const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    return {
        time: nextMonth.toLocaleString('zh-CN', { 
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }),
        days,
        hours,
        formatted: `${days}天${hours}小时后`
    };
};

const getBackupCount = async () => {
    try {
        if (!existsSync(BACKUP_DIR)) {
            return 0;
        }
        
        const files = await fs.readdir(BACKUP_DIR);
        const backupFiles = files.filter(file => file.startsWith('stats-backup-') && file.endsWith('.json'));
        return backupFiles.length;
    } catch (error) {
        console.error('❌ 获取备份数量失败:', error);
        return 0;
    }
};

loadStats();

app.use('*', cors());
app.use('*', logger());

app.use('/api', async (c, next) => {
    const startTime = Date.now();
    await next();
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    if (c.req.url.includes('/api') && c.res.status === 200) {
        await updateStats();
        
        if (!isVercel && useMySQL && dbPool) {
            const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for') || 'unknown';
            const userAgent = c.req.header('user-agent') || 'unknown';
            
            await dbOperations.logApiRequest(
                c.req.path,
                c.req.method,
                c.res.status,
                responseTime,
                ip,
                userAgent
            );
        }
    }
});

if (!isVercel) {
    app.use('*', async (c, next) => {
        await checkAndResetStats();
        await next();
    });
}

app.get('/api', api);
app.get('/test', handler);

app.get('/health', (c) => {
    return c.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        mysql: dbPool ? 'connected' : 'disabled',
        storage: useMySQL ? 'database' : 'local',
        isVercel: isVercel
    });
});

const statsEndpoints = {
    getStats: (c) => {
        const todayCalls = getTodayCalls();
        const weekCalls = getWeekCalls();
        const monthCalls = getMonthCalls();
        const nextReset = getNextResetTime();
        const nextWeeklyReset = getNextWeeklyReset();
        const nextMonthlyReset = getNextMonthlyReset();
        
        return c.json({
            success: true,
            data: {
                totalCalls: apiStats.totalCalls,
                todayCalls,
                weekCalls,
                monthCalls,
                dailyStats: apiStats.dailyCalls,
                hourlyStats: apiStats.hourlyCalls,
                weeklyStats: apiStats.weeklyCalls,
                monthlyStats: apiStats.monthlyCalls,
                lastUpdated: apiStats.lastUpdated,
                lastResetDate: apiStats.lastResetDate,
                lastWeeklyReset: apiStats.lastWeeklyReset,
                lastMonthlyReset: apiStats.lastMonthlyReset,
                nextReset: nextReset.time,
                timeToReset: nextReset.formatted,
                nextWeeklyReset: nextWeeklyReset.time,
                timeToWeeklyReset: nextWeeklyReset.formatted,
                nextMonthlyReset: nextMonthlyReset.time,
                timeToMonthlyReset: nextMonthlyReset.formatted,
                storageType: useMySQL ? '数据库' : '本地文件',
                resetInfo: "总调用次数永不重置，今日调用每天00:00重置，每周一重置，每月1号重置",
                resetTime: "00:00 (北京)",
                serverTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
                timestamp: new Date().toISOString()
            }
        });
    },

    resetToday: async (c) => {
        const today = getBeijingDateString();
        
        await createBackup();
        
        apiStats.dailyCalls[today] = 0;
        apiStats.lastResetDate = today;
        
        await saveStats();
        return c.json({ 
            success: true, 
            message: '今日统计已重置',
            resetDate: today,
            totalCalls: apiStats.totalCalls,
            todayCalls: 0
        });
    },

    resetWeek: async (c) => {
        const weekKey = getWeekKey();
        
        apiStats.weeklyCalls[weekKey] = 0;
        apiStats.lastWeeklyReset = weekKey;
        
        await saveStats();
        return c.json({ 
            success: true, 
            message: '本周统计已重置',
            resetWeek: weekKey,
            weekCalls: 0
        });
    },

    resetMonth: async (c) => {
        const monthKey = getMonthKey();
        
        apiStats.monthlyCalls[monthKey] = 0;
        apiStats.lastMonthlyReset = monthKey;
        
        await saveStats();
        return c.json({ 
            success: true, 
            message: '本月统计已重置',
            resetMonth: monthKey,
            monthCalls: 0
        });
    },

    resetAll: async (c) => {
        const today = getBeijingDateString();
        const weekKey = getWeekKey();
        const monthKey = getMonthKey();
        
        await createBackup();
        
        apiStats = {
            totalCalls: 0,
            dailyCalls: {},
            hourlyCalls: {},
            weeklyCalls: {},
            monthlyCalls: {},
            lastUpdated: new Date().toISOString(),
            lastResetDate: today,
            lastWeeklyReset: weekKey,
            lastMonthlyReset: monthKey
        };
        
        await saveStats();
        return c.json({ 
            success: true, 
            message: '所有统计数据已重置',
            warning: '总调用次数也被重置了！'
        });
    },

    storageInfo: (c) => {
        return c.json({
            success: true,
            data: {
                storageType: useMySQL ? '数据库' : '本地文件',
                mysqlEnabled: useMySQL,
                mysqlConnected: dbPool !== null,
                localFileExists: !isVercel && existsSync(STATS_FILE),
                isVercel,
                environment: isVercel ? 'Vercel' : 'Local'
            }
        });
    },

    migrateToDB: async (c) => {
        if (!dbPool) {
            return c.json({
                success: false,
                message: '数据库未连接，无法迁移数据'
            }, 400);
        }
        
        try {
            await migrateFromFileToDB();
            return c.json({
                success: true,
                message: '数据迁移完成',
                storageType: '数据库'
            });
        } catch (error) {
            return c.json({
                success: false,
                message: '数据迁移失败: ' + error.message
            }, 500);
        }
    },

    getBackups: async (c) => {
        try {
            if (!existsSync(BACKUP_DIR)) {
                await fs.mkdir(BACKUP_DIR, { recursive: true });
            }

            const files = await fs.readdir(BACKUP_DIR);
            const backupFiles = files.filter(file => file.startsWith('stats-backup-') && file.endsWith('.json'));
            
            const backupList = await Promise.all(
                backupFiles.map(async (file) => {
                    const filePath = path.join(BACKUP_DIR, file);
                    const stats = await fs.stat(filePath);
                    return {
                        filename: file,
                        size: stats.size,
                        created: stats.mtime.toISOString(),
                        createdFormatted: stats.mtime.toLocaleString('zh-CN', { 
                            timeZone: 'Asia/Shanghai',
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: false
                        })
                    };
                })
            );

            backupList.sort((a, b) => new Date(b.created) - new Date(a.created));

            return c.json({
                success: true,
                data: {
                    backupDir: BACKUP_DIR,
                    totalBackups: backupList.length,
                    maxBackups: 3,
                    backups: backupList
                }
            });
        } catch (error) {
            return c.json({
                success: false,
                message: '获取备份列表失败: ' + error.message
            }, 500);
        }
    },

    createBackup: async (c) => {
        try {
            const backupFile = await createBackup();
            
            if (backupFile) {
                return c.json({
                    success: true,
                    message: '备份创建成功',
                    backupFile: path.basename(backupFile),
                    totalBackups: await getBackupCount(),
                    maxBackups: 3
                });
            } else {
                return c.json({
                    success: false,
                    message: '备份创建失败'
                }, 500);
            }
        } catch (error) {
            return c.json({
                success: false,
                message: '创建备份失败: ' + error.message
            }, 500);
        }
    },

    getAnalytics: async (c) => {
        if (!dbPool) {
            return c.json({
                success: false,
                message: '数据库未连接，无法获取分析数据'
            }, 400);
        }
        
        try {
            const analyticsData = await dbOperations.getAnalytics();
            
            if (analyticsData) {
                return c.json({
                    success: true,
                    data: {
                        ...analyticsData,
                        totalRequests: apiStats.totalCalls,
                        todayRequests: getTodayCalls(),
                        weekRequests: getWeekCalls(),
                        monthRequests: getMonthCalls()
                    }
                });
            } else {
                return c.json({
                    success: false,
                    message: '无法获取分析数据'
                }, 500);
            }
        } catch (error) {
            return c.json({
                success: false,
                message: '获取分析数据失败: ' + error.message
            }, 500);
        }
    }
};

app.get('/stats', statsEndpoints.getStats);
app.post('/stats/reset-today', statsEndpoints.resetToday);
app.post('/stats/reset-week', statsEndpoints.resetWeek);
app.post('/stats/reset-month', statsEndpoints.resetMonth);
app.post('/stats/reset-all', statsEndpoints.resetAll);
app.get('/stats/storage-info', statsEndpoints.storageInfo);
app.post('/stats/migrate-to-db', statsEndpoints.migrateToDB);
app.get('/stats/backups', statsEndpoints.getBackups);
app.post('/stats/create-backup', statsEndpoints.createBackup);
app.get('/stats/analytics', statsEndpoints.getAnalytics);

app.get('/', (c) => {
    const currentTime = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const runtime = get_runtime();
    const baseUrl = get_url(c);
    
    const getApiUrl = () => {
        const protocol = c.req.header('X-Forwarded-Proto') || 'https';
        const host = c.req.header('Host') || new URL(c.req.url).host;
        let base = protocol + '://' + host;
        const currentPath = new URL(c.req.url).pathname;
        
        if (isVercel) {
            return base + '/api';
        } else {
            if (currentPath.startsWith('/meting')) {
                return base + '/api';
            } else {
                return base + '/meting/api';
            }
        }
    };
    
    const apiUrl = getApiUrl();
    
    const getTestUrl = () => {
        const protocol = c.req.header('X-Forwarded-Proto') || 'https';
        const host = c.req.header('Host') || new URL(c.req.url).host;
        let base = protocol + '://' + host;
        const currentPath = new URL(c.req.url).pathname;
        
        if (isVercel) {
            return base + '/test';
        } else {
            if (currentPath.startsWith('/meting')) {
                return base + '/test';
            } else {
                return base + '/meting/test';
            }
        }
    };
    
    const testUrl = getTestUrl();
    
    const getHealthUrl = () => {
        const protocol = c.req.header('X-Forwarded-Proto') || 'https';
        const host = c.req.header('Host') || new URL(c.req.url).host;
        let base = protocol + '://' + host;
        const currentPath = new URL(c.req.url).pathname;
        
        if (isVercel) {
            return base + '/health';
        } else {
            if (currentPath.startsWith('/meting')) {
                return base + '/health';
            } else {
                return base + '/meting/health';
            }
        }
    };
    
    const healthUrl = getHealthUrl();
    
    const getCorrectBaseUrl = () => {
        const protocol = c.req.header('X-Forwarded-Proto') || 'https';
        const host = c.req.header('Host') || new URL(c.req.url).host;
        return protocol + '://' + host;
    };
    
    const correctBaseUrl = getCorrectBaseUrl();
    
    const today = getBeijingDateString();
    const totalCalls = apiStats.totalCalls;
    const todayCalls = getTodayCalls();
    const weekCalls = getWeekCalls();
    const monthCalls = getMonthCalls();
    const lastUpdated = new Date(apiStats.lastUpdated).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const nextReset = getNextResetTime();
    const nextWeeklyReset = getNextWeeklyReset();
    const nextMonthlyReset = getNextMonthlyReset();
    
    const storageType = useMySQL ? '数据库' : '本地文件';
    const storageIcon = useMySQL ? '💾' : '📁';
    
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>初叶🍂Meting API</title>
    <meta name="description" content="初叶Meting API服务 - 提供稳定可靠的音乐API接口">
    
    <link rel="icon" href="https://cloud.chuyel.top/f/PkZsP/tu%E5%B7%B2%E5%8E%BB%E5%BA%95.png" type="image/png">
    <link rel="shortcut icon" href="https://cloud.chuyel.top/f/PkZsP/tu%E5%B7%B2%E5%8E%BB%E5%BA%95.png" type="image/png">
    <link rel="apple-touch-icon" href="https://cloud.chuyel.top/f/PkZsP/tu%E5%B7%B2%E5%8E%BB%E5%BA%95.png">
    
    <link rel="icon" type="image/png" href="https://cloud.chuyel.top/f/PkZsP/tu%E5%B7%B2%E5%8E%BB%E5%BA%95.png">
    <link rel="icon" href="https://cloud.chuyel.top/f/PkZsP/tu%E5%B7%B2%E5%8E%BB%E5%BA%95.png" sizes="any">
    
    <meta name="theme-color" content="#50B7FE">
    
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            transition: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease;
        }
        
        :root {
            --bg-gradient: linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5)), 
                          url('https://api.boxmoe.com/random.php?size=mw1024') no-repeat center center fixed;
            --bg-overlay: rgba(0, 0, 0, 0.4);
            --header-bg: rgba(255, 255, 255, 0.15);
            --card-bg: rgba(255, 255, 255, 0.15);
            --card-bg-hover: rgba(255, 255, 255, 0.2);
            --text-primary: #ffffff;
            --text-secondary: rgba(255, 255, 255, 0.9);
            --text-muted: rgba(255, 255, 255, 0.8);
            --border-color: rgba(255, 255, 255, 0.2);
            --shadow-color: rgba(0, 0, 0, 0.3);
            --accent-color: #50B7FE;
            --accent-hover: #3a9fe8;
            --success-color: #2ecc71;
            --warning-color: #FFE92C;
            --stat-week: #FF9C00;
            --stat-month: #10FBDF;
            --btn-primary: linear-gradient(45deg, #50B7FE, #3a9fe8);
            --btn-success: linear-gradient(45deg, #2ecc71, #27ae60);
            --btn-purple: linear-gradient(45deg, #9b59b6, #8e44ad);
            --btn-orange: linear-gradient(45deg, #ff7e5f, #feb47b);
            --stat-total: #50B7FE;
            --stat-today: #FFE92C;
            /* 新增版本药丸渐变颜色变量 */
            --version-gradient: linear-gradient(90deg, #50B7FE, #FFE92C);
        }
        
        [data-theme="light"] {
            --bg-gradient: linear-gradient(rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.8)), 
                          url('https://api.boxmoe.com/random.php?size=mw1024') no-repeat center center fixed;
            --bg-overlay: rgba(255, 255, 255, 0.4);
            --header-bg: rgba(255, 255, 255, 0.9);
            --card-bg: rgba(255, 255, 255, 0.85);
            --card-bg-hover: rgba(255, 255, 255, 0.95);
            --text-primary: #2c3e50;
            --text-secondary: #34495e;
            --text-muted: #7f8c8d;
            --border-color: rgba(0, 0, 0, 0.1);
            --shadow-color: rgba(0, 0, 0, 0.15);
            --accent-color: #50B7FE;
            --accent-hover: #3a9fe8;
            --success-color: #2ecc71;
            --warning-color: #FFE92C;
            --stat-week: #FF9C00;
            --stat-month: #10FBDF;
            --btn-primary: linear-gradient(45deg, #50B7FE, #3a9fe8);
            --btn-success: linear-gradient(45deg, #2ecc71, #27ae60);
            --btn-purple: linear-gradient(45deg, #9b59b6, #5a32a3);
            --btn-orange: linear-gradient(45deg, #ff7e5f, #e8590c);
            --stat-total: #50B7FE;
            --stat-today: #FFE92C;
            /* 浅色主题下的版本药丸渐变颜色 */
            --version-gradient: linear-gradient(90deg, #50B7FE, #FFE92C);
        }
        
        body {
            font-family: 'Segoe UI', 'Microsoft YaHei', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--bg-gradient);
            background-size: cover;
            min-height: 100vh;
            color: var(--text-primary);
            line-height: 1.6;
            position: relative;
        }
        
        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: var(--bg-overlay);
            z-index: -1;
        }
        
        .theme-toggle {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 1000;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 50px;
            padding: 8px 16px;
            backdrop-filter: blur(10px);
            box-shadow: 0 4px 15px var(--shadow-color);
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        
        .theme-toggle:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px var(--shadow-color);
        }
        
        .theme-toggle span {
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--text-primary);
        }
        
        .theme-icon {
            font-size: 1.2rem;
            transition: transform 0.3s ease;
        }
        
        [data-theme="light"] .theme-icon.sun {
            display: none;
        }
        
        [data-theme="light"] .theme-icon.moon {
            display: inline;
        }
        
        [data-theme="dark"] .theme-icon.sun {
            display: inline;
        }
        
        [data-theme="dark"] .theme-icon.moon {
            display: none;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem;
        }
        
        header {
            text-align: center;
            margin-bottom: 3rem;
            padding: 2rem;
            background: var(--header-bg);
            border-radius: 20px;
            box-shadow: 0 10px 30px var(--shadow-color);
            backdrop-filter: blur(10px);
            border: 1px solid var(--border-color);
        }
        
        .logo {
            font-size: 3.5rem;
            margin-bottom: 1rem;
            animation: float 3s ease-in-out infinite;
        }
        
        h1 {
            font-size: 2.5rem;
            color: var(--text-primary);
            margin-bottom: 0.5rem;
            text-shadow: 0 2px 10px var(--shadow-color);
        }
        
        .tagline {
            font-size: 1.2rem;
            color: var(--text-secondary);
            margin-bottom: 1rem;
            text-shadow: 0 1px 5px var(--shadow-color);
        }
        
        .version-badge {
            display: inline-block;
            background: var(--version-gradient);
            color: white;
            padding: 0.5rem 1rem;
            border-radius: 50px;
            font-size: 0.9rem;
            font-weight: bold;
            margin-bottom: 1rem;
            box-shadow: 0 4px 15px var(--shadow-color);
            animation: versionPulse 3s infinite alternate;
        }
        
        @keyframes versionPulse {
            0% {
                background: linear-gradient(90deg, #50B7FE, #FFE92C);
                box-shadow: 0 4px 15px rgba(80, 183, 254, 0.5);
            }
            100% {
                background: linear-gradient(90deg, #3AA7FE, #FFD700);
                box-shadow: 0 6px 20px rgba(80, 183, 254, 0.7), 0 0 30px rgba(255, 233, 44, 0.3);
            }
        }
        
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-bottom: 3rem;
        }
        
        .info-card {
            background: var(--card-bg);
            padding: 1.5rem;
            border-radius: 15px;
            box-shadow: 0 5px 15px var(--shadow-color);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            border: 1px solid var(--border-color);
            backdrop-filter: blur(10px);
        }
        
        .info-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 30px var(--shadow-color);
            background: var(--card-bg-hover);
        }
        
        .info-card h3 {
            color: var(--accent-color);
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            text-shadow: 0 1px 5px var(--shadow-color);
        }
        
        .info-card h3::before {
            content: '📋';
            font-size: 1.2rem;
        }
        
        .info-item {
            margin-bottom: 1rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid var(--border-color);
        }
        
        .info-item:last-child {
            border-bottom: none;
            margin-bottom: 0;
            padding-bottom: 0;
        }
        
        .label {
            font-weight: 600;
            color: var(--text-secondary);
            margin-bottom: 0.25rem;
            text-shadow: 0 1px 3px var(--shadow-color);
        }
        
        .value {
            color: var(--text-primary);
            word-break: break-all;
            text-shadow: 0 1px 3px var(--shadow-color);
        }
        
        .value a {
            color: var(--accent-color);
            text-decoration: none;
        }
        
        .value a:hover {
            color: var(--accent-hover);
            text-decoration: underline;
        }
        
        .status-badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 600;
            margin-left: 0.5rem;
            box-shadow: 0 2px 8px var(--shadow-color);
        }
        
        .status-online {
            background: var(--btn-success);
            color: white;
        }
        
        .status-local {
            background: var(--btn-primary);
            color: white;
        }
        
        .actions {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-top: 2rem;
        }
        
        .action-card {
            background: var(--card-bg);
            padding: 2rem;
            border-radius: 15px;
            text-align: center;
            box-shadow: 0 5px 15px var(--shadow-color);
            transition: all 0.3s ease;
            border: 1px solid var(--border-color);
            backdrop-filter: blur(10px);
        }
        
        .action-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 20px 40px var(--shadow-color);
            background: var(--card-bg-hover);
        }
        
        .action-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
            filter: drop-shadow(0 2px 5px var(--shadow-color));
        }
        
        .action-card h3 {
            color: var(--text-primary);
            margin-bottom: 1rem;
            text-shadow: 0 1px 5px var(--shadow-color);
        }
        
        .action-card p {
            color: var(--text-secondary);
            margin-bottom: 1.5rem;
            font-size: 0.95rem;
            text-shadow: 0 1px 3px var(--shadow-color);
        }
        
        .btn {
            display: inline-block;
            padding: 0.75rem 1.5rem;
            background: var(--btn-primary);
            color: white;
            text-decoration: none;
            border-radius: 50px;
            font-weight: 600;
            transition: all 0.3s ease;
            border: none;
            cursor: pointer;
            font-size: 1rem;
            box-shadow: 0 4px 15px var(--shadow-color);
        }
        
        .btn:hover {
            transform: scale(1.05);
            box-shadow: 0 6px 20px rgba(80, 183, 254, 0.4);
        }
        
        .btn-api {
            background: var(--btn-purple);
        }
        
        .btn-api:hover {
            box-shadow: 0 6px 20px rgba(155, 89, 182, 0.4);
        }
        
        .btn-test {
            background: var(--btn-success);
        }
        
        .btn-test:hover {
            box-shadow: 0 6px 20px rgba(46, 204, 113, 0.4);
        }
        
        footer {
            text-align: center;
            margin-top: 3rem;
            padding: 2rem;
            color: var(--text-muted);
            font-size: 0.9rem;
            background: var(--card-bg);
            border-radius: 15px;
            border: 1px solid var(--border-color);
            backdrop-filter: blur(10px);
        }
        
        .time-display {
            font-size: 1.1rem;
            color: var(--warning-color);
            font-weight: 600;
            margin-top: 0.5rem;
            text-shadow: 0 1px 5px var(--shadow-color);
        }
        
        .stats-container {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 10px;
            margin-top: 10px;
        }
        
        .stat-item {
            text-align: center;
            padding: 10px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            border: 1px solid var(--border-color);
        }
        
        .stat-number {
            font-size: 1.3rem;
            font-weight: bold;
            margin-bottom: 5px;
            text-shadow: 0 2px 8px var(--shadow-color);
        }
        
        .stat-label {
            font-size: 0.8rem;
            color: var(--text-secondary);
            text-shadow: 0 1px 3px var(--shadow-color);
        }
        
        .stat-total {
            color: var(--stat-total);
        }
        
        .stat-today {
            color: var(--stat-today);
        }
        
        .stat-week {
            color: var(--stat-week);
        }
        
        .stat-month {
            color: var(--stat-month);
        }
        
        .vercel-notice {
            margin-top: 10px;
            padding: 10px;
            background: rgba(255, 193, 7, 0.1);
            border-radius: 8px;
            border-left: 3px solid var(--warning-color);
            font-size: 0.9rem;
        }
        
        .vercel-notice strong {
            color: var(--warning-color);
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .spinning {
            animation: spin 2s linear infinite;
        }
        
        @media (max-width: 768px) {
            .container {
                padding: 1rem;
            }
            
            h1 {
                font-size: 2rem;
            }
            
            .logo {
                font-size: 2.5rem;
            }
            
            .theme-toggle {
                top: 10px;
                right: 10px;
                padding: 6px 12px;
            }
            
            .info-grid {
                grid-template-columns: 1fr;
            }
            
            .actions {
                grid-template-columns: 1fr;
            }
            
            .stats-container {
                grid-template-columns: repeat(2, 1fr);
                gap: 10px;
            }
        }
        
        @media (max-width: 480px) {
            .stats-container {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="theme-toggle" id="themeToggle" title="切换深色/浅色模式">
        <span class="theme-icon sun">🌞</span>
        <span class="theme-icon moon">🌙</span>
        <span id="themeText">深色模式</span>
    </div>
    
    <div class="container">
        <header>
            <div class="logo">
                <img src="https://cloud.chuyel.top/f/PkZsP/tu%E5%B7%B2%E5%8E%BB%E5%BA%95.png" 
                     alt="初叶Logo" 
                     style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 4px solid var(--border-color); box-shadow: 0 8px 25px var(--shadow-color); background: var(--card-bg); padding: 3px; animation: float 3s ease-in-out infinite;">
            </div>
            <h1>初叶🍂Meting API</h1>
            <p class="tagline">初叶🍂Meting API-1.5.0 祝各位2026年新年快乐！！！</p>
            <div class="version-badge">版本 v1.5.0</div>
            ${isVercel ? `
            <div class="vercel-notice">
                <strong>🌐 Vercel环境说明：</strong> 当前运行在Vercel无状态环境中，统计数据无法保存。如需API调用统计，请部署到本地或自有服务器。
            </div>` : ''}
        </header>
        
        <div class="info-grid">
            <div class="info-card">
                <h3>系统信息</h3>
                <div class="info-item">
                    <div class="label">运行环境</div>
                    <div class="value">
                        ${runtime}
                        <span class="status-badge ${runtime.includes('Node') ? 'status-online' : 'status-local'}">
                            ${runtime.includes('Node') ? '生产环境' : '开发环境'}
                        </span>
                        ${isVercel ? '<span class="status-badge status-warning" style="background: linear-gradient(45deg, #000000, #484848); color: white;">Vercel</span>' : ''}
                    </div>
                </div>
                <div class="info-item">
                    <div class="label">存储方式</div>
                    <div class="value">
                        ${storageIcon} ${storageType}
                        ${isVercel ? '<span style="color: var(--warning-color); margin-left: 10px;">(无法统计)</span>' : ''}
                    </div>
                </div>
                <div class="info-item">
                    <div class="label">服务端口</div>
                    <div class="value">${config.PORT}</div>
                </div>
                <div class="info-item">
                    <div class="label">部署地区</div>
                    <div class="value">
                        ${config.OVERSEAS ? '海外服务器' : '中国大陆服务器'}
                        <span class="status-badge ${config.OVERSEAS ? 'status-local' : 'status-online'}">
                            ${config.OVERSEAS ? '海外' : '大陆'}
                        </span>
                    </div>
                </div>
                <div class="info-item">
                    <div class="label">健康检查</div>
                    <div class="value">
                        <a href="${healthUrl}" style="color: var(--accent-color);">${healthUrl}</a>
                    </div>
                </div>
                ${!isVercel ? `
                <div class="info-item">
                    <div class="label">API 调用统计</div>
                    <div class="value">
                        <div class="stats-container">
                            <div class="stat-item">
                                <div class="stat-number stat-total">${totalCalls.toLocaleString()}</div>
                                <div class="stat-label">总调用次数</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-number stat-today">${todayCalls.toLocaleString()}</div>
                                <div class="stat-label">今日调用</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-number stat-week">${weekCalls.toLocaleString()}</div>
                                <div class="stat-label">本周调用</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-number stat-month">${monthCalls.toLocaleString()}</div>
                                <div class="stat-label">本月调用</div>
                            </div>
                        </div>
                    </div>
                </div>` : ''}
            </div>
            
            <div class="info-card">
                <h3>服务状态</h3>
                <div class="info-item">
                    <div class="label">当前时间</div>
                    <div class="value time-display">${currentTime}</div>
                </div>
                <div class="info-item">
                    <div class="label">API 状态</div>
                    <div class="value">
                        <span class="status-badge status-online">运行正常</span>
                        ${isVercel ? '<span class="status-badge" style="background: linear-gradient(45deg, #000000, #484848); color: white; margin-left: 5px;">Vercel</span>' : ''}
                    </div>
                </div>
                ${!isVercel ? `
                <div class="info-item">
                    <div class="label">统计更新</div>
                    <div class="value">${lastUpdated}</div>
                </div>
                <div class="info-item">
                    <div class="label">下次重置</div>
                    <div class="value">
                        今日：${nextReset.time}<br>
                        本周：${nextWeeklyReset.time}<br>
                        本月：${nextMonthlyReset.time}
                    </div>
                </div>` : ''}
                <div class="info-item">
                    <div class="label">访问地址</div>
                    <div class="value">
                        <a href="${c.req.url}">${c.req.url}</a>
                    </div>
                </div>
                <div class="info-item">
                    <div class="label">实际地址</div>
                    <div class="value">
                        <a href="${correctBaseUrl}">${correctBaseUrl}</a>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="actions">
            <div class="action-card">
                <div class="action-icon">🔧</div>
                <h3>测试接口</h3>
                <p>验证服务是否正常运行，查看基本响应信息</p>
                <a href="${testUrl}" class="btn btn-test">前往测试</a>
            </div>
            
            <div class="action-card">
                <div class="action-icon">
                    <img src="https://cloud.chuyel.top/f/PkZsP/tu%E5%B7%B2%E5%8E%BB%E5%BA%95.png" 
                         alt="初叶图标"
                         style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color); box-shadow: 0 4px 15px var(--shadow-color);">
                </div>
                <h3>初叶🍂网站</h3>
                <p>该项目作者的官方网站</p>
                <a href="https://www.chuyel.top" class="btn btn-api" target="_blank">点击访问</a>
            </div>
            
            <div class="action-card">
                <div class="action-icon">📚</div>
                <h3>文档</h3>
                <p>查看 API 使用文档</p>
                <a href="https://www.chuyel.top/archives/472" class="btn" target="_blank">查看文档</a>
            </div>
        </div>
        
        <footer>
            <p>© 2024-2025 初叶🍂Meting API| 提供稳定可靠的API支持</p>
            ${!isVercel ? `<p>API调用统计：总 <span style="color: var(--accent-color); font-weight: bold;">${totalCalls.toLocaleString()}</span> 次 | 今日 <span style="color: var(--stat-today); font-weight: bold;">${todayCalls.toLocaleString()}</span> 次 | 本周 <span style="color: var(--stat-week); font-weight: bold;">${weekCalls.toLocaleString()}</span> 次 | 本月 <span style="color: var(--stat-month); font-weight: bold;">${monthCalls.toLocaleString()}</span> 次</p>` : ''}
            <p>最后更新：${lastUpdated} | 如有问题，请查看文档或联系技术支持</p>
            <p style="margin-top: 10px; font-size: 0.8rem; color: var(--text-muted);">
                <span>主题：<span id="currentTheme">深色模式</span> | </span>
                <span>部署环境：${isVercel ? 'Vercel' : '其他'} | </span>
                <span>背景图片：<a href="https://api.boxmoe.com" target="_blank" style="color: var(--accent-color);">随机壁纸API</a></span>
            </p>
        </footer>
    </div>
    
    <script>
        const themeToggle = document.getElementById('themeToggle');
        const themeText = document.getElementById('themeText');
        const currentThemeSpan = document.getElementById('currentTheme');
        const html = document.documentElement;
        
        const savedTheme = localStorage.getItem('theme');
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        
        function initTheme() {
            let theme = 'dark';
            
            if (savedTheme) {
                theme = savedTheme;
            } else if (systemPrefersDark) {
                theme = 'dark';
            } else {
                theme = 'light';
            }
            
            applyTheme(theme);
        }
        
        function applyTheme(theme) {
            html.setAttribute('data-theme', theme);
            
            if (theme === 'light') {
                themeText.textContent = '浅色模式';
                currentThemeSpan.textContent = '浅色模式';
                themeToggle.querySelector('.theme-icon').classList.remove('spinning');
            } else {
                themeText.textContent = '深色模式';
                currentThemeSpan.textContent = '深色模式';
            }
            
            localStorage.setItem('theme', theme);
            
            const icon = themeToggle.querySelector('.theme-icon');
            icon.classList.add('spinning');
            setTimeout(() => {
                icon.classList.remove('spinning');
            }, 600);
        }
        
        function toggleTheme() {
            const currentTheme = html.getAttribute('data-theme') || 'dark';
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            applyTheme(newTheme);
        }
        
        themeToggle.addEventListener('click', toggleTheme);
        
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            if (!savedTheme) {
                const newTheme = e.matches ? 'dark' : 'light';
                applyTheme(newTheme);
            }
        });
        
        function updateTime() {
            const now = new Date();
            const options = {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                weekday: 'long',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
                timeZone: 'Asia/Shanghai'
            };
            const timeStr = now.toLocaleString('zh-CN', options);
            const timeElement = document.querySelector('.time-display');
            if (timeElement) {
                timeElement.textContent = timeStr;
            }
        }
        
        setInterval(updateTime, 1000);
        
        document.addEventListener('DOMContentLoaded', function() {
            initTheme();
            
            const cards = document.querySelectorAll('.info-card, .action-card');
            cards.forEach((card, index) => {
                card.style.opacity = '0';
                card.style.transform = 'translateY(20px)';
                
                setTimeout(() => {
                    card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
                    card.style.opacity = '1';
                    card.style.transform = 'translateY(0)';
                }, index * 100);
            });
            
            updateTime();
        });
        
        window.addEventListener('load', function() {
            const bgImage = new Image();
            bgImage.src = 'https://api.boxmoe.com/random.php?size=mw1024';
            bgImage.onload = function() {
                console.log('🎨 背景图片加载完成');
                const currentTheme = html.getAttribute('data-theme') || 'dark';
                const bgOverlay = currentTheme === 'dark' 
                    ? 'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5))' 
                    : 'linear-gradient(rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.8))';
                
                document.body.style.background = bgOverlay + ', url("' + this.src + '") no-repeat center center fixed';
                document.body.style.backgroundSize = 'cover';
            };
            bgImage.onerror = function() {
                console.log('⚠️ 背景图片加载失败，使用备用背景');
                const currentTheme = html.getAttribute('data-theme') || 'dark';
                if (currentTheme === 'dark') {
                    document.body.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)';
                } else {
                    document.body.style.background = 'linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)';
                }
            };
        });
        
        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey && e.shiftKey && e.key === 'T') {
                e.preventDefault();
                toggleTheme();
            }
        });
    </script>
</body>
</html>`;
    
    return c.html(html);
});

const cleanup = async () => {
    console.log('\n🔄 正在关闭服务器，清理资源...');
    
    if (dbPool) {
        try {
            await dbPool.end();
            console.log('✅ 数据库连接池已关闭');
        } catch (error) {
            console.error('❌ 关闭数据库连接池失败:', error);
        }
    }
    
    console.log('👋 服务器已优雅关闭');
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGUSR2', cleanup);

process.on('uncaughtException', (error) => {
    console.error('❌ 未捕获的异常:', error);
    cleanup();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未处理的 Promise 拒绝:', reason);
});

export default app