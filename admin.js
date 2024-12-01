const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { loadWhitelist, saveWhitelist } = require('./utils/whitelist');

const router = express.Router();
const WEBHOOK_WHITELIST_URL = "https://hook.eu2.make.com/mvi4kvg6arzxrxd5462f6nh2yqq1p5ot"; // Your Make.com webhook URL
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // Admin Token for authorization
const { loadUsers, logUserActivity } = require('./utils/whitelist');

// Middleware to check admin token
const checkAdminToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${ADMIN_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Utility to send webhook updates
const sendWebhookUpdate = async (type, payload) => {
    try {
        const response = await fetch(WEBHOOK_WHITELIST_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, payload }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to send webhook update');
        }

        console.log(`Webhook update sent successfully: ${type}`);
    } catch (error) {
        console.error('Error sending webhook update:', error.message);
        throw error;
    }
};

// Add wallet to whitelist
router.post('/addToWhitelist', checkAdminToken, async (req, res) => {
    try {
        const { walletAddress, label, whitelistStart } = req.body;

        if (!walletAddress || !label || !whitelistStart) {
            return res.status(400).json({ error: 'Invalid data. walletAddress, label, and whitelistStart are required.' });
        }

        const whitelist = loadWhitelist();
        const existingWallet = whitelist.find(entry => entry.walletAddress === walletAddress);

        if (existingWallet) {
            return res.status(400).json({ error: 'Wallet address is already whitelisted.' });
        }

        // Add new entry to whitelist
        const newEntry = { walletAddress, label, whitelistStart };
        whitelist.push(newEntry);
        saveWhitelist(whitelist);

        // Trigger webhook with updated whitelist
        await sendWebhookUpdate('addToWhitelist', newEntry);

        res.json({ message: 'Wallet added to whitelist and webhook triggered successfully.' });
    } catch (error) {
        console.error('Error adding to whitelist:', error.message);
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

// Remove wallet from whitelist
router.post('/removeFromWhitelist', checkAdminToken, async (req, res) => {
    try {
        const { walletAddress } = req.body;

        if (!walletAddress) {
            return res.status(400).json({ error: 'Invalid data. walletAddress is required.' });
        }

        const whitelist = loadWhitelist();
        const updatedWhitelist = whitelist.filter(entry => entry.walletAddress !== walletAddress);

        if (whitelist.length === updatedWhitelist.length) {
            return res.status(404).json({ error: 'Wallet address not found in whitelist.' });
        }

        saveWhitelist(updatedWhitelist);

        // Trigger webhook with updated whitelist
        await sendWebhookUpdate('removeFromWhitelist', { walletAddress });

        res.json({ message: 'Wallet removed from whitelist and webhook triggered successfully.' });
    } catch (error) {
        console.error('Error removing from whitelist:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Add endpoint to fetch users
router.get('/getUsers', checkAdminToken, (req, res) => {
    try {
        const users = loadUsers();
        res.json({ users });
    } catch (error) {
        console.error('Error fetching users:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Add endpoint to log user activity manually (optional)
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

module.exports = router;
