const fs = require('fs/promises');
const path = require('path');
const Joi = require('joi');

// File paths
const whitelistFilePath = process.env.WHITELIST_FILE_PATH || path.join(__dirname, 'whitelist.json');
const usersFilePath = process.env.USERS_FILE_PATH || path.join(__dirname, 'users.json');

// Helper: Ensure file exists and initialize if missing
const ensureFileExists = async (filePath, defaultContent = '[]') => {
    try {
        await fs.access(filePath).catch(async () => {
            await fs.writeFile(filePath, defaultContent);
            console.log(`File ${filePath} initialized with default content.`);
        });
    } catch (error) {
        console.error(`Error creating file ${filePath}:`, error.message);
        throw error;
    }
};

// Helper: Load data from a JSON file
const loadFileData = async (filePath) => {
    await ensureFileExists(filePath);
    try {
        const rawData = await fs.readFile(filePath, 'utf8');
        return JSON.parse(rawData);
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error.message);
        throw new Error(`Could not load data from file: ${filePath}`);
    }
};

// Helper: Save data to a JSON file
const saveFileData = async (filePath, data) => {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Error writing to file ${filePath}:`, error.message);
        throw new Error(`Could not save data to file: ${filePath}`);
    }
};

// Schema Validators
const walletAddressSchema = Joi.string().pattern(/^erd[a-z0-9]{59}$/).required();
const whitelistEntrySchema = Joi.object({
    walletAddress: walletAddressSchema,
    label: Joi.string().min(3).required(),
    whitelistStart: Joi.date().iso().required(),
});

// Load whitelist
const loadWhitelist = async () => {
    try {
        return await loadFileData(whitelistFilePath);
    } catch (error) {
        console.error('Error loading whitelist:', error.message);
        return [];
    }
};

// Save whitelist
const saveWhitelist = async (whitelist) => {
    try {
        await saveFileData(whitelistFilePath, whitelist);
    } catch (error) {
        console.error('Error saving whitelist:', error.message);
        throw error;
    }
};

// Add a wallet to the whitelist
const addToWhitelist = async (walletAddress, label, whitelistStart) => {
    const { error } = whitelistEntrySchema.validate({ walletAddress, label, whitelistStart });
    if (error) throw new Error(error.details[0].message);

    const whitelist = await loadWhitelist();
    if (whitelist.some(entry => entry.walletAddress === walletAddress)) {
        throw new Error(`Wallet ${walletAddress} is already whitelisted.`);
    }

    const newEntry = { walletAddress, label, whitelistStart };
    whitelist.push(newEntry);
    await saveWhitelist(whitelist);
    return { message: `Wallet ${walletAddress} added to the whitelist.`, entry: newEntry };
};

// Remove a wallet from the whitelist
const removeFromWhitelist = async (walletAddress) => {
    const { error } = walletAddressSchema.validate(walletAddress);
    if (error) throw new Error(error.details[0].message);

    const whitelist = await loadWhitelist();
    const updatedWhitelist = whitelist.filter(entry => entry.walletAddress !== walletAddress);

    if (whitelist.length === updatedWhitelist.length) {
        throw new Error(`Wallet ${walletAddress} is not in the whitelist.`);
    }

    await saveWhitelist(updatedWhitelist);
    return { message: `Wallet ${walletAddress} removed from the whitelist.` };
};

// Load users
const loadUsers = async () => {
    try {
        return await loadFileData(usersFilePath);
    } catch (error) {
        console.error('Error loading users:', error.message);
        return [];
    }
};

// Save users
const saveUsers = async (users) => {
    try {
        await saveFileData(usersFilePath, users);
    } catch (error) {
        console.error('Error saving users:', error.message);
        throw error;
    }
};

// Log user activity
const logUserActivity = async (walletAddress) => {
    const { error } = walletAddressSchema.validate(walletAddress);
    if (error) throw new Error(error.details[0].message);

    const users = await loadUsers();
    const currentDate = new Date().toISOString();

    // Add a new entry with the current timestamp
    const newEntry = { walletAddress, authorizedAt: currentDate };
    users.push(newEntry);

    await saveUsers(users);
    return { message: `User activity logged for wallet ${walletAddress} at ${currentDate}.`, entry: newEntry };
};

// Check if a wallet is whitelisted
const isWhitelisted = async (walletAddress) => {
    const { error } = walletAddressSchema.validate(walletAddress);
    if (error) {
        throw new Error(`Wallet address validation failed: ${error.details[0].message}`);
    }

    const whitelist = await loadWhitelist();
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
