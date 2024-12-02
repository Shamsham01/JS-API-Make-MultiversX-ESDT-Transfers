const fs = require('fs');
const path = require('path');

// File paths
const whitelistFilePath = path.join(__dirname, 'whitelist.json');
const usersFilePath = path.join(__dirname, 'users.json');

// Helper: Ensure file exists and initialize if missing
const ensureFileExists = (filePath, defaultContent = '[]') => {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, defaultContent);
    }
};

// Helper: Load data from a JSON file
const loadFileData = (filePath) => {
    ensureFileExists(filePath);
    try {
        const rawData = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(rawData);
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error.message);
        return [];
    }
};

// Helper: Save data to a JSON file
const saveFileData = (filePath, data) => {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Error writing to file ${filePath}:`, error.message);
        throw error;
    }
};

// Load whitelist
const loadWhitelist = () => loadFileData(whitelistFilePath);

// Save whitelist
const saveWhitelist = (whitelist) => saveFileData(whitelistFilePath, whitelist);

// Add a wallet to the whitelist
const addToWhitelist = (walletAddress, label, whitelistStart) => {
    const whitelist = loadWhitelist();
    if (whitelist.some(entry => entry.walletAddress === walletAddress)) {
        throw new Error(`Wallet ${walletAddress} is already whitelisted.`);
    }

    const newEntry = { walletAddress, label, whitelistStart };
    whitelist.push(newEntry);
    saveWhitelist(whitelist);
    return { message: `Wallet ${walletAddress} added to the whitelist.`, entry: newEntry };
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
const loadUsers = () => loadFileData(usersFilePath);

// Save users
const saveUsers = (users) => saveFileData(usersFilePath, users);

// Log user activity
const logUserActivity = (walletAddress) => {
    const users = loadUsers();
    const currentDate = new Date().toISOString();

    // Add a new entry with the current timestamp
    const newEntry = { walletAddress, authorizedAt: currentDate };
    users.push(newEntry);

    saveUsers(users);
    return { message: `User activity logged for wallet ${walletAddress} at ${currentDate}.`, entry: newEntry };
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
