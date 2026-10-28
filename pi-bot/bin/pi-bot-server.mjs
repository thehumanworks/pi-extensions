#!/usr/bin/env node
import { main } from "../dist/server/main.js";

process.exitCode = await main();
