const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const { pool, initializeDatabase } = require('./db');
const { uploadProfilePicture, deleteProfilePicture } = require('./azureStorage');

const app = express();
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey12345';

// Middleware
app.use(cors());
app.use(express.json());

// Serve local uploads statically for development fallback
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure Multer for file upload in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Custom wrapper to handle multer errors gracefully
const uploadSingleImage = (req, res, next) => {
  upload.single('picture')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
};

// Auth Middleware to protect dashboard route or check user session
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Sign Up Route
app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password } = req.body;

  // Basic Validation
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields (username, email, password) are required.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  try {
    // Check if user already exists
    const [existingUsers] = await pool.query(
      'SELECT id FROM users WHERE email = ? OR username = ?',
      [email, username]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'Username or Email is already registered.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Insert user
    const [result] = await pool.query(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username, email, hashedPassword]
    );

    const userId = result.insertId;

    // Generate JWT
    const token = jwt.sign({ id: userId, username, email }, JWT_SECRET, { expiresIn: '24h' });

    res.status(201).json({
      message: 'User registered successfully!',
      token,
      user: {
        id: userId,
        username,
        email,
        profile_picture_url: null
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

// Sign In Route
app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    // Find user by email
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = users[0];

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        profile_picture_url: user.profile_picture_url
      }
    });
  } catch (error) {
    console.error('Signin error:', error);
    res.status(500).json({ error: 'Internal server error during authentication.' });
  }
});

// Get Current User (Me) Route
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, username, email, profile_picture_url, created_at FROM users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ user: users[0] });
  } catch (error) {
    console.error('Fetch user error:', error);
    res.status(500).json({ error: 'Internal server error fetching user.' });
  }
});

// Upload Profile Picture Route
app.put('/api/users/profile-picture', authenticateToken, uploadSingleImage, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Please upload an image file.' });
  }

  try {
    // 1. Get user's current details to delete existing picture if any
    const [users] = await pool.query('SELECT profile_picture_url FROM users WHERE id = ?', [req.user.id]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const currentPicUrl = users[0].profile_picture_url;
    if (currentPicUrl) {
      await deleteProfilePicture(currentPicUrl);
    }

    // 2. Upload new picture
    const hostUrl = `${req.protocol}://${req.get('host')}`;
    const newPicUrl = await uploadProfilePicture(
      req.user.id,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      hostUrl
    );

    // 3. Update database
    await pool.query('UPDATE users SET profile_picture_url = ? WHERE id = ?', [newPicUrl, req.user.id]);

    res.json({
      message: 'Profile picture updated successfully!',
      profile_picture_url: newPicUrl
    });
  } catch (error) {
    console.error('Upload profile picture error:', error);
    res.status(500).json({ error: 'Internal server error uploading profile picture.' });
  }
});

// Delete Profile Picture Route
app.delete('/api/users/profile-picture', authenticateToken, async (req, res) => {
  try {
    // 1. Get user's current profile picture
    const [users] = await pool.query('SELECT profile_picture_url FROM users WHERE id = ?', [req.user.id]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const currentPicUrl = users[0].profile_picture_url;
    if (!currentPicUrl) {
      return res.status(400).json({ error: 'No profile picture to delete.' });
    }

    // 2. Delete from storage
    await deleteProfilePicture(currentPicUrl);

    // 3. Update database
    await pool.query('UPDATE users SET profile_picture_url = NULL WHERE id = ?', [req.user.id]);

    res.json({ message: 'Profile picture removed successfully!' });
  } catch (error) {
    console.error('Delete profile picture error:', error);
    res.status(500).json({ error: 'Internal server error removing profile picture.' });
  }
});

// Catch-all route for status check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Backend service is running.' });
});

// Initialize database and start the server
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to start server due to database initialization failure:', err);
  process.exit(1);
});
