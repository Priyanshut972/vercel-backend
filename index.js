require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { OpenAI } = require('openai');
const cors = require('cors');

const app = express();

// Enhanced CORS configuration
app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Initialize SQLite database
const db = new sqlite3.Database('./retail.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize database schema and sample data
function initializeDatabase() {
  db.serialize(() => {
    // Create tables
    db.run(`CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      region TEXT,
      signup_date TEXT
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT,
      category TEXT,
      price REAL,
      cost REAL
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      order_date TEXT,
      total_amount REAL,
      status TEXT
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS order_items (
      order_id TEXT,
      product_id TEXT,
      quantity INTEGER,
      price REAL
    )`);
    
    // Insert sample data
    db.run(`INSERT OR IGNORE INTO customers VALUES 
      ('C001', 'John Smith', 'john@example.com', 'North', '2023-01-15'),
      ('C002', 'Sarah Johnson', 'sarah@example.com', 'South', '2023-02-20')`);
    
    db.run(`INSERT OR IGNORE INTO products VALUES
      ('P001', 'Wireless Headphones', 'Electronics', 99.99, 45.00),
      ('P002', 'Smart Watch', 'Electronics', 199.99, 120.00),
      ('P003', 'Cotton T-Shirt', 'Apparel', 29.99, 12.50)`);
    
    db.run(`INSERT OR IGNORE INTO orders VALUES
      ('O001', 'C001', '2023-05-15', 129.98, 'Completed'),
      ('O002', 'C002', '2023-05-16', 199.99, 'Completed')`);
    
    db.run(`INSERT OR IGNORE INTO order_items VALUES
      ('O001', 'P001', 1, 99.99),
      ('O001', 'P003', 1, 29.99),
      ('O002', 'P002', 1, 199.99)`);
  });
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    database: 'connected',
    ai: 'ready'
  });
});

// Business question analysis endpoint
app.post('/api/analyze', async (req, res) => {
  try {
    const { question } = req.body;
    
    // Validate question
    if (!question || question.trim().length < 3) {
      return res.status(400).json({ error: 'Please ask a complete business question' });
    }
    
    // Get schema information
    const schema = await getSchemaInfo();
    
    // Generate SQL with AI
    const sqlResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a SQL expert analyzing a retail database. 
          Only respond to business questions about sales, customers, or products.
          For non-business questions, say "Please ask about sales, products, or customers."
          Database schema: ${JSON.stringify(schema)}`
        },
        { role: "user", content: question }
      ],
      temperature: 0.3
    });
    
    const responseText = sqlResponse.choices[0].message.content;
    
    // Check if it's a non-business question
    if (responseText.includes("Please ask about")) {
      return res.json({
        insights: responseText,
        data: [],
        sql: null,
        chartType: null
      });
    }
    
    const generatedSql = extractSql(responseText);
    
    // Execute query if we got SQL
    let data = [];
    if (generatedSql && generatedSql.toLowerCase().includes('select')) {
      data = await new Promise((resolve, reject) => {
        db.all(generatedSql, [], (err, rows) => {
          if (err) {
            console.error('SQL Error:', err);
            reject(new Error('Error executing query'));
          } else {
            resolve(rows);
          }
        });
      });
    }
    
    // Generate insights
    const insightResponse = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Analyze this retail data and provide business insights: ${JSON.stringify(data)}.
          Suggest visualization type (bar, line, pie).`
        },
        { role: "user", content: question }
      ],
      temperature: 0.3
    });
    
    const insights = insightResponse.choices[0].message.content;
    
    res.json({ 
      sql: generatedSql,
      data: data,
      insights: insights,
      chartType: suggestChartType(insights)
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Helper functions
async function getSchemaInfo() {
  return new Promise((resolve, reject) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
      if (err) return reject(err);
      
      const schemaInfo = [];
      let tablesProcessed = 0;
      
      tables.forEach(table => {
        db.all(`PRAGMA table_info(${table.name})`, [], (err, columns) => {
          if (err) return reject(err);
          
          schemaInfo.push({
            table: table.name,
            columns: columns.map(col => ({
              name: col.name,
              type: col.type
            }))
          });
          
          tablesProcessed++;
          if (tablesProcessed === tables.length) {
            resolve(schemaInfo);
          }
        });
      });
    });
  });
}

function extractSql(text) {
  if (!text) return null;
  const sqlMatch = text.match(/```sql\n([\s\S]*?)\n```/) || text.match(/SELECT .*?FROM/i);
  return sqlMatch ? (sqlMatch[1] || sqlMatch[0]) : null;
}

function suggestChartType(insights) {
  if (!insights) return 'bar';
  if (insights.includes('trend')) return 'line';
  if (insights.includes('compare')) return 'bar';
  if (insights.includes('percentage') || insights.includes('proportion')) return 'pie';
  return 'bar';
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Test endpoint: http://localhost:${PORT}/api/health`);
});