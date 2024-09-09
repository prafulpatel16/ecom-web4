const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const redis = require('redis');
require('dotenv').config();
const { connectRabbitMQ, sendToQueue, consumeFromQueue, getMessagesFromQueue } = require('./rabbitmq.js');
const jwt = require('express-jwt'); // For validating JWT tokens
const jwksRsa = require('jwks-rsa'); // To retrieve signing keys from Auth0

// Initialize the Express application
const app = express();

// Configure PostgreSQL connection
const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.POSTGRES_PORT,
});

const redisClient = redis.createClient({
    host: process.env.REDIS_HOST || 'redis',  
    port: process.env.REDIS_PORT || 6379,
  });

redisClient.on('error', (err) => {
  console.error('Failed to connect to Redis:', err);
});

// Enable CORS
app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Middleware to parse JSON bodies
app.use(express.json());

// JWT middleware to check the validity of the JWT token
const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`
  }),
  audience: process.env.AUTH0_AUDIENCE,
  issuer: `https://${process.env.AUTH0_DOMAIN}/`,
  algorithms: ['RS256']
});

// Root route (optional authentication)
app.get('/', (req, res) => {
  res.send(req.user ? 'Logged in' : 'Logged out');
});

// Profile route (requires authentication)
app.get('/profile', checkJwt, (req, res) => {
  res.json(req.user);
});

// Get products endpoint with Redis caching (protected with JWT)
app.get('/api/products', checkJwt, async (req, res) => {
  try {
    redisClient.get('products', async (err, cachedProducts) => {
      if (err) throw err;

      if (cachedProducts) {
        res.json({
          products: JSON.parse(cachedProducts),
          cacheStatus: 'hit'
        });
      } else {
        const result = await pool.query('SELECT * FROM products');
        const products = result.rows;

        // Store result in Redis cache with expiration time of 60 seconds
        redisClient.setex('products', 60, JSON.stringify(products));

        res.json({
          products: products,
          cacheStatus: 'miss'
        });
      }
    });
  } catch (err) {
    console.error('Failed to fetch products:', err);
    res.status(500).send('Server error');
  }
});

// Add product and invalidate Redis cache, send to RabbitMQ (protected with JWT)
app.post('/api/products', checkJwt, async (req, res) => {
  const { name, price } = req.body;

  if (!name || !price) {
    return res.status(400).json({ message: 'Product name and price are required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO products (name, price) VALUES ($1, $2) RETURNING *',
      [name, price]
    );

    // Invalidate Redis cache
    redisClient.del('products');

    // Send the new product to RabbitMQ queue
    sendToQueue('product_queue', JSON.stringify({ action: 'add', product: result.rows[0] }));

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Failed to add product:', err);
    res.status(500).json({ message: 'Failed to add product' });
  }
});

// Update product and invalidate Redis cache, send to RabbitMQ (protected with JWT)
app.put('/api/products/:id', checkJwt, async (req, res) => {
  const { id } = req.params;
  const { name, price } = req.body;

  if (!name || !price) {
    return res.status(400).json({ message: 'Product name and price are required' });
  }

  try {
    const result = await pool.query(
      'UPDATE products SET name = $1, price = $2 WHERE id = $3 RETURNING *',
      [name, price, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Invalidate Redis cache
    redisClient.del('products');

    // Send the updated product to RabbitMQ queue
    sendToQueue('product_queue', JSON.stringify({ action: 'update', product: result.rows[0] }));

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Failed to update product:', err);
    res.status(500).json({ message: 'Failed to update product' });
  }
});

// Delete product and invalidate Redis cache, send to RabbitMQ (protected with JWT)
app.delete('/api/products/:id', checkJwt, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM products WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Invalidate Redis cache
    redisClient.del('products');

    // Send the delete action to RabbitMQ queue
    sendToQueue('product_queue', JSON.stringify({ action: 'delete', productId: id }));

    res.status(200).json({ message: 'Product deleted', product: result.rows[0] });
  } catch (err) {
    console.error('Failed to delete product:', err);
    res.status(500).json({ message: 'Failed to delete product' });
  }
});

// Clear Redis cache endpoint (optional, no JWT protection)
app.get('/api/cache/clear', (req, res) => {
  redisClient.del('products', (err) => {
    if (err) {
      console.error('Failed to clear Redis cache:', err);
      res.status(500).json({ message: 'Failed to clear Redis cache' });
    } else {
      res.status(200).json({ message: 'Redis cache cleared successfully' });
    }
  });
});

// RabbitMQ-related routes (protected with JWT)
app.post('/api/product_queue', checkJwt, async (req, res) => {
  const { product } = req.body;

  if (product) {
    try {
      sendToQueue('product_queue', JSON.stringify(product));
      res.status(200).json({ message: 'Message sent to queue' });
    } catch (err) {
      console.error('Failed to send message to queue:', err);
      res.status(500).json({ message: 'Failed to send message' });
    }
  } else {
    res.status(400).json({ message: 'Product data is required' });
  }
});

// Fetch RabbitMQ messages from the queue (protected with JWT)
app.get('/api/queue/product_queue', checkJwt, async (req, res) => {
  try {
    const messages = getMessagesFromQueue(); // Fetch messages from the queue
    res.status(200).json(messages);
  } catch (err) {
    console.error('Failed to fetch messages from queue:', err);
    res.status(500).json({ message: 'Failed to fetch messages from queue' });
  }
});

// Connect to RabbitMQ and start consuming messages
connectRabbitMQ().then(() => {
  consumeFromQueue('product_queue', (message) => {
    console.log('Message processed:', message);
  });
});

// Start the server
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
