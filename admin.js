const express = require('express');
const axios = require('axios'); // Replace node-fetch with axios
const Joi = require('joi');
const { loadWhitelist, saveWhitelist, loadUsers, saveUsers, logUserActivity } = require('./utils/whitelist');
const { UserSigner } = require('@multiversx/sdk-wallet');

const router = express.Router();
const WEBHOOK_WHITELIST_URL = process.env.WEBHOOK_WHITELIST_URL || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

if (!WEBHOOK_WHITELIST_URL || !ADMIN_TOKEN) {
    throw new Error("Required environment variables WEBHOOK_WHITELIST_URL and ADMIN_TOKEN are missing");
}

// Middleware to check admin token
const checkAdminToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${ADMIN_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Utility to send webhook updates with labeled data
const sendWebhookUpdate = async (type, payload, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.post(WEBHOOK_WHITELIST_URL, {
                type,
                payload,
                timestamp: new Date().toISOString(),
            }, {
                headers: { 'Content-Type': 'application/json' },
            });

            console.log(`Webhook update sent successfully: ${type}`);
            return;
        } catch (error) {
            console.error(`Retrying webhook (${i + 1}/${retries}):`, error.response?.data?.message || error.message);
            if (i === retries - 1) throw error;
        }
    }
};

// Validation schemas
const addToWhitelistSchema = Joi.object({
    walletAddress: Joi.string().pattern(/^erd[a-z0-9]{62}$/).required();
    label: Joi.string().min(3).required(),
    whitelistStart: Joi.date().iso().required(),
});

const removeFromWhitelistSchema = Joi.object({
    walletAddress: Joi.string().pattern(/^erd[a-z0-9]{58}$/).required(),
});

// Add wallet to whitelist
router.post('/addToWhitelist', checkAdminToken, async (req, res) => {
    const { error } = addToWhitelistSchema.validate(req.body);
    if (error) {
        return res.status(400).json({ error: error.details[0].message });
    }

    try {
        const { walletAddress, label, whitelistStart } = req.body;
        const whitelist = loadWhitelist();
        if (whitelist.find(entry => entry.walletAddress === walletAddress)) {
            return res.status(400).json({ error: 'Wallet address is already whitelisted.' });
        }

        const newEntry = { walletAddress, label, whitelistStart };
        whitelist.push(newEntry);
        saveWhitelist(whitelist);

        await sendWebhookUpdate('addToWhitelist', newEntry);
        res.json({ message: 'Wallet added to whitelist successfully.' });
    } catch (error) {
        console.error('Error adding to whitelist:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Remove wallet from whitelist
router.post('/removeFromWhitelist', checkAdminToken, async (req, res) => {
    const { error } = removeFromWhitelistSchema.validate(req.body);
    if (error) {
        return res.status(400).json({ error: error.details[0].message });
    }

    try {
        const { walletAddress } = req.body;
        const whitelist = loadWhitelist();
        const updatedWhitelist = whitelist.filter(entry => entry.walletAddress !== walletAddress);

        if (whitelist.length === updatedWhitelist.length) {
            return res.status(404).json({ error: 'Wallet address not found in whitelist.' });
        }

        saveWhitelist(updatedWhitelist);
        await sendWebhookUpdate('removeFromWhitelist', { walletAddress });
        res.json({ message: 'Wallet removed from whitelist successfully.' });
    } catch (error) {
        console.error('Error removing from whitelist:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get current whitelist
router.get('/getWhitelist', checkAdminToken, (req, res) => {
    try {
        const whitelist = loadWhitelist();
        res.json(whitelist);
    } catch (error) {
        console.error('Error retrieving whitelist:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get users with duplicates allowed
router.get('/getUsers', checkAdminToken, (req, res) => {
    try {
        const users = loadUsers();
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Log user activity (manually if needed)
router.post('/logUserActivity', checkAdminToken, (req, res) => {
    try {
        const { walletAddress } = req.body;

        if (!walletAddress) {
            return res.status(400).json({ error: 'Wallet address is required.' });
        }

        const response = logUserActivity(walletAddress);
        res.json(response);
    } catch (error) {
        console.error('Error logging user activity:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Update users.json via /authorize endpoint only
router.post('/authorize', async (req, res) => {
    try {
        const { walletPem } = req.body;

        if (!walletPem || typeof walletPem !== 'string' || !walletPem.includes('-----BEGIN PRIVATE KEY-----')) {
            return res.status(400).json({ error: 'Invalid wallet PEM provided.' });
        }

        const walletSigner = UserSigner.fromPem(walletPem);
        const walletAddress = walletSigner.getAddress().toString();

        const users = loadUsers();
        const newEntry = { walletAddress, timestamp: new Date().toISOString() };
        users.push(newEntry);
        saveUsers(users);

        res.json({
            message: 'Authorization successful.',
            walletAddress,
        });
    } catch (error) {
        console.error('Error during authorization:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
