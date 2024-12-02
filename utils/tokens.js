const fetch = require('node-fetch');
const BigNumber = require('bignumber.js');

// Constants
const API_BASE_URL = "https://api.multiversx.com";
const tokenDecimalsCache = {}; // In-memory cache for token decimals

// Fetch token decimals
const getTokenDecimals = async (tokenTicker) => {
    try {
        // Check if decimals are cached
        if (tokenDecimalsCache[tokenTicker]) {
            return tokenDecimalsCache[tokenTicker];
        }

        const apiUrl = `${API_BASE_URL}/tokens/${tokenTicker}`;
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch token info for ${tokenTicker}: ${response.statusText}`);
        }
        const tokenInfo = await response.json();
        const decimals = tokenInfo.decimals || 0;

        // Cache the decimals
        tokenDecimalsCache[tokenTicker] = decimals;

        return decimals;
    } catch (error) {
        console.error(`Error fetching decimals for token ${tokenTicker}:`, error.message);
        throw new Error('Unable to retrieve token decimals. Please try again later.');
    }
};

// Convert amount to blockchain value based on decimals
const convertAmountToBlockchainValue = (amount, decimals) => {
    try {
        const factor = new BigNumber(10).pow(decimals);
        return new BigNumber(amount).multipliedBy(factor).toFixed(0);
    } catch (error) {
        console.error('Error converting amount to blockchain value:', error.message);
        throw new Error('Invalid amount or decimals provided for conversion.');
    }
};

// Convert blockchain value to human-readable amount
const convertBlockchainValueToAmount = (value, decimals) => {
    try {
        const factor = new BigNumber(10).pow(decimals);
        return new BigNumber(value).dividedBy(factor).toFixed(decimals);
    } catch (error) {
        console.error('Error converting blockchain value to amount:', error.message);
        throw new Error('Invalid value or decimals provided for conversion.');
    }
};

module.exports = {
    getTokenDecimals,
    convertAmountToBlockchainValue,
    convertBlockchainValueToAmount,
};
