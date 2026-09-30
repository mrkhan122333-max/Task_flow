'use strict';

// Dead module — no longer mounted by server.js and never referenced anywhere
// else in the project. Kept only so it can still be deleted on the server:
// safe to remove at any time.
const express = require('express');

module.exports = express.Router();