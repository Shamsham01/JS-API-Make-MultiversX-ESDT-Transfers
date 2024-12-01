const fs = require('fs');
const path = require('path');

// File paths
const whitelistFilePath = path.join(__dirname, 'whitelist.json');
const usersFilePath = path.join(__dirname, 'users.json');

// Helper to ensure file existence and initialize if missing
const ensureFileExists = (filePath, defaultContent = '[]') => {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, defaultContent);
    }
};

// Load data from a JSON file
const loadFileData = (filePath) => {
    ensureFileExists(filePath);
    const rawData = fs.readFileSync(filePath);
    return JSON.parse(rawData);
};

// Save data to a JSON file
const saveFileData = (filePath, data) => {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

// Load whitelist
const loadWhitelist = () => {
    return loadFileData(whitelistFilePath);
};

// Save whitelist
const saveWhitelist = (whitelist) => {
    saveFileData(whitelistFilePath, whitelist);
};

// Add a wallet to the whitelist
const addToWhitelist = (walletAddress, label, whitelistStart) => {
    const whitelist = loadWhitelist();
    const existingEntry = whitelist.find(entry => entry.walletAddress === walletAddress);

    if (existingEntry) {
        throw new Error(`Wallet ${walletAddress} is already whitelisted.`);
    }

    whitelist.push({ walletAddress, label, whitelistStart });
    saveWhitelist(whitelist);
    return { message: `Wallet ${walletAddress} added to the whitelist.` };
};

// Remove a wallet from the whitelist
const removeFromWhitelist = (walletAddress) => {
    const whitelist = loadWhitelist();
    const updatedWhitelist = whitelist.filter(entry => entry.walletAddress !== walletAddress);

    if (whitelist.length === updatedWhitelist.length) {
        throw new Error(`Wallet ${walletAddress} is not in the whitelist.`);
    }

    saveWhitelist(updatedWhitelist);
    return { message: `Wallet ${walletAddress} removed from the whitelist.` };
};

// Load users
const loadUsers = () => {
    return loadFileData(usersFilePath);
};

// Save users
const saveUsers = (users) => {
    saveFileData(usersFilePath, users);
};

// Add user activity
const logUserActivity = (walletAddress) => {
    const users = loadUsers();
    const currentDate = new Date().toISOString();

    // Always log a new entry with the current timestamp
    users.push({
        walletAddress,
        authorizedAt: currentDate,
    });

    saveUsers(users);
    return { message: `User activity logged for wallet ${walletAddress} at ${currentDate}.` };
};

// Check if a wallet is whitelisted
const isWhitelisted = (walletAddress) => {
    const whitelist = loadWhitelist();
    return whitelist.some(entry => entry.walletAddress === walletAddress);
};

module.exports = {
    loadWhitelist,
    saveWhitelist,
    addToWhitelist,
    removeFromWhitelist,
    loadUsers,
    saveUsers,
    logUserActivity,
    isWhitelisted,
};
