const express = require('express');
const bodyParser = require('body-parser');
const adminRoutes = require('./admin');
const transfersRoutes = require('./transfers');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');

// Initialize the Express application
const app = express();

// Constants
const PORT = process.env.PORT || 10000;
const API_BASE_URL = "https://api.multiversx.com"; // Replace if you're using a custom provider
const CLIENT_NAME = "MultiversX Transfers API for Make.com Custom Apps";

// Initialize SDK provider
const provider = new ProxyNetworkProvider(API_BASE_URL, { clientName: CLIENT_NAME });

// Middleware
app.use(bodyParser.json()); // Parse JSON-encoded bodies

// Routes
app.use('/admin', adminRoutes);
app.use('/transfers', transfersRoutes);

// Test Endpoint for SDK Provider
app.get('/health', async (req, res) => {
    try {
        const networkStatus = await provider.getNetworkStatus();
        res.json({ status: "API is healthy", networkStatus });
    } catch (error) {
        console.error("Error fetching network status:", error.message);
        res.status(500).json({ error: "Unable to fetch network status" });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Client Name: ${CLIENT_NAME}`);
});
