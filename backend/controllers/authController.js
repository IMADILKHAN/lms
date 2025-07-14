// backend/controllers/authController.js
const User = require('../models/User.js');
const Branch = require('../models/Branch.js');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const faceapi = require('face-api.js');
const { Canvas, Image, ImageData } = require('canvas');

// Face-API setup
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
Promise.all([
    // Hum yahan models ko project ke root se load karenge
    faceapi.nets.ssdMobilenetv1.loadFromDisk('./models'),
    faceapi.nets.faceLandmark68Net.loadFromDisk('./models'),
    faceapi.nets.faceRecognitionNet.loadFromDisk('./models'),
]).then(() => console.log('Face-API models loaded successfully!'));

// Email Transporter Setup
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

const generateToken = (id, role) => {
    return jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

// --- REGISTER USER ---
exports.registerUser = async (req, res) => {
    const { firstName, lastName, email, password, branchId, faceImageBase64 } = req.body;

    if (!firstName || !lastName || !email || !password || !branchId || !faceImageBase64 || !req.file) {
        return res.status(400).json({ success: false, message: 'Please provide all required fields.' });
    }

    try {
        if (await User.findOne({ email })) {
            return res.status(400).json({ success: false, message: 'User already exists.' });
        }

        const image = new Image();
        image.src = faceImageBase64;
        const detection = await faceapi.detectSingleFace(image).withFaceLandmarks().withFaceDescriptor();
        if (!detection) {
            return res.status(400).json({ success: false, message: 'Face not detected in the image.' });
        }
        const faceDescriptor = Array.from(detection.descriptor);

        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationUrl = `${process.env.FRONTEND_URL}/verify-email/${verificationToken}`;

        const user = new User({
            firstName,
            lastName,
            email,
            password,
            branch: branchId,
            idCardImageUrl: req.file.path,
            faceDescriptor,
            emailVerificationToken: verificationToken,
            isEmailVerified: false,
            idCardVerificationStatus: 'pending',
        });

        const mailOptions = {
            from: `"LMS Platform" <${process.env.EMAIL_USER}>`,
            to: user.email,
            subject: 'Verify Your Email for LMS Platform',
            html: `<h3>Welcome to LMS Platform!</h3>
                   <p>Thank you for registering. Please click the link below to verify your email address:</p>
                   <a href="${verificationUrl}" style="background-color: #4CAF50; color: white; padding: 14px 25px; text-align: center; text-decoration: none; display: inline-block;">Verify Email</a>
                   <p>If that doesn't work, copy and paste this URL into your browser:</p>
                   <p>${verificationUrl}</p>`,
        };

        await transporter.sendMail(mailOptions);
        await user.save();

        res.status(201).json({ success: true, message: 'Registration successful! Please check your email to verify your account.' });

    } catch (error) {
        console.error('Registration or Email Error:', error);
        if (error.code === 'EAUTH' || error.responseCode === 535) {
            return res.status(500).json({ success: false, message: 'Server error: Could not send verification email. Please check server configuration.' });
        }
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
};


// --- VERIFY EMAIL ---
exports.verifyEmail = async (req, res) => {
    try {
        const { token } = req.params;
        if (!token) {
            return res.status(400).json({ success: false, message: 'Verification token not provided.' });
        }

        const user = await User.findOne({ emailVerificationToken: token });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification token. Please register again.' });
        }

        user.isEmailVerified = true;
        user.emailVerificationToken = undefined;
        await user.save();

        res.status(200).json({ success: true, message: 'Email verified successfully! You can now log in.' });

    } catch (error) {
        console.error('Email Verification Error:', error);
        res.status(500).json({ success: false, message: 'Server error during email verification.' });
    }
};


// --- LOGIN USER (SECURITY FIX APPLIED) ---
exports.loginUser = async (req, res) => {
    // Ab hum frontend se 'faceImageBase64' bhi lenge
    const { email, password, faceImageBase64 } = req.body;

    if (!email || !password || !faceImageBase64) {
        return res.status(400).json({ success: false, message: 'Please provide email, password, and face image.' });
    }

    try {
        const user = await User.findOne({ email }).select('+password');

        if (!user || !(await user.matchPassword(password))) {
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }

        if (!user.isEmailVerified) {
            return res.status(401).json({ success: false, message: 'Please verify your email before trying to log in.' });
        }

        // --- YAHAN SECURITY FIX LAGU KIYA GAYA HAI ---

        // 1. Login ke samay diye gaye image se face detect karein
        const loginImage = new Image();
        loginImage.src = faceImageBase64;
        const loginDetection = await faceapi.detectSingleFace(loginImage).withFaceLandmarks().withFaceDescriptor();

        if (!loginDetection) {
            return res.status(400).json({ success: false, message: 'Face not detected in the login image. Please try again.' });
        }

        // 2. Database mein save kiye gaye descriptor se milaan karein
        const storedDescriptor = new Float32Array(user.faceDescriptor);
        const faceMatcher = new faceapi.FaceMatcher([storedDescriptor]);
        const bestMatch = faceMatcher.findBestMatch(loginDetection.descriptor);

        // 3. Check karein ki chehra match hua ya nahi
        // bestMatch.distance 0 (perfect match) aur 1 (no match) ke beech hota hai.
        // 0.4 se neeche ka distance ek accha match mana jaata hai.
        if (bestMatch.label === 'unknown' || bestMatch.distance > 0.4) {
            return res.status(401).json({ success: false, message: 'Face verification failed. Please ensure you are in a well-lit area and try again.' });
        }

        // Agar sab kuch sahi hai, tabhi token generate karein
        const token = generateToken(user._id, user.role);
        res.status(200).json({
            success: true,
            token,
            user: {
                _id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
};


// --- GET USER PROFILE ---
exports.getUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).populate('branch', 'name description');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        res.status(200).json({ success: true, user });
    } catch (error) {
        console.error('Get Profile Error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};


// --- UPDATE USER PROFILE ---
exports.updateUserProfile = async (req, res) => {
    const { firstName, lastName, branchId, password } = req.body;
    try {
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        user.firstName = firstName || user.firstName;
        user.lastName = lastName || user.lastName;

        if (branchId) {
            const branchExists = await Branch.findById(branchId);
            if (!branchExists) {
                return res.status(400).json({ success: false, message: 'Invalid Branch ID' });
            }
            user.branch = branchId;
        } else if (branchId === null || branchId === '') {
            user.branch = null;
        }

        if (password) {
            if (password.length < 6) {
                return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
            }
            user.password = password;
        }

        const updatedUser = await user.save();
        const populatedUser = await User.findById(updatedUser._id).populate('branch', 'name');

        res.status(200).json({
            success: true,
            user: {
                _id: populatedUser._id,
                firstName: populatedUser.firstName,
                lastName: populatedUser.lastName,
                email: populatedUser.email,
                role: populatedUser.role,
                branch: populatedUser.branch,
            },
        });
    } catch (error) {
        console.error('Update Profile Error:', error);
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(val => val.message);
            return res.status(400).json({ success: false, message: messages.join(', ') });
        }
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};