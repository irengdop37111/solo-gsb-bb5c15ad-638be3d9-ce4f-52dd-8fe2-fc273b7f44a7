'use strict';

const path = require('path');
const express = require('express');
const { open } = require('./db');
const { createApi } = require('./routes');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'charter.db');

const db = open(DB_PATH);
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', createApi(db));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 非 API 路径回退到 SPA 入口
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), (err) => err && next(err));
});

// drafts.js 抛出的业务错误（err.status）统一映射
app.use((err, req, res, next) => {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`社团章程修订应用已启动: http://${HOST}:${PORT}`);
  console.log(`数据库: ${DB_PATH}`);
});

const shutdown = () => server.close(() => db.close());
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
