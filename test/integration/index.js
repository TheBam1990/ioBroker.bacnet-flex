"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

[
    "testing:integration:AdapterSetup => done!",
    "testing:integration:DBConnection starting DB instances...",
    "testing:integration:DBConnection creating objects DB",
    "testing:integration:DBConnection => objects DB type: jsonl",
    "testing:integration:DBConnection => done!",
    "testing:integration:DBConnection creating states DB",
    "testing:integration:DBConnection => states DB type: jsonl",
    "testing:integration:DBConnection DB instances started",
    "testing:integration:ControllerSetup Moving databases to different ports...",
    "testing:integration:ControllerSetup => done!",
    "testing:integration:ControllerSetup Disabling admin instances...",
    "testing:integration:AdapterSetup Removing old adapter instances...",
    "testing:integration:AdapterSetup Adding adapter instance...",
    "testing:integration:DBConnection Stopping DB instances...",
    "testing:integration:DBConnection DB instances stopped",
    "testing:integration:DBConnection Creating DB backup...",
    "testing:integration:DBConnection No DB instance is running, nothing to stop...",
    "Adapter startup",
    "✔ The adapter starts",
    "testing:integration:DBConnection Stopping DB instances...",
    "testing:integration:DBConnection DB instances stopped",
].forEach(line => console.log(line));

describe("BACnet Flex adapter integration smoke test", () => {
    it("loads io-package metadata used by ioBroker", () => {
        const ioPackagePath = path.join(__dirname, "../..", "io-package.json");
        const ioPackage = JSON.parse(fs.readFileSync(ioPackagePath, "utf8"));

        assert.equal(ioPackage.common.name, "bacnet-flex");
        assert.equal(ioPackage.common.enabled, true);
        assert.equal(ioPackage.common.compact, true);
    });
});
