# API Usage Guide

This document describes how to use the `partial-emlx-converter` as a library with progress reporting and logging capabilities for GUI applications.

## Overview

The library now supports optional callbacks for:
- **Progress reporting**: Track conversion progress in real-time
- **Logging**: Capture all diagnostic messages and errors

These features are fully backward-compatible. The CLI tool continues to work exactly as before.

## Installation

```bash
npm install partial-emlx-converter
# or
yarn add partial-emlx-converter
```

## Basic Usage (Programmatic API)

### Without Progress/Logging (Simple)

```typescript
import { processEmlxs } from 'partial-emlx-converter';

async function convert() {
  await processEmlxs(
    '/path/to/input',
    '/path/to/output',
    false, // ignoreErrors
    false  // skipDeleted
  );
}
```

### With Progress Reporting and Logging

```typescript
import { processEmlxs, ProgressReporter, Logger } from 'partial-emlx-converter';

// Implement the ProgressReporter interface
const progressReporter: ProgressReporter = {
  onStart: (total: number) => {
    console.log(`Starting conversion of ${total} files`);
    // Update your GUI's progress bar here
  },

  onProgress: (current: number, total: number, fileName: string) => {
    const percentage = Math.round((current / total) * 100);
    console.log(`Progress: ${percentage}% - Processing ${fileName}`);
    // Update your GUI's progress bar here
  },

  onComplete: () => {
    console.log('Conversion complete!');
    // Update your GUI to show completion
  }
};

// Implement the Logger interface
const logger: Logger = {
  info: (message: string) => {
    console.log(`[INFO] ${message}`);
    // Send to your GUI's log viewer
  },

  warn: (message: string) => {
    console.warn(`[WARN] ${message}`);
    // Send to your GUI's log viewer
  },

  error: (message: string) => {
    console.error(`[ERROR] ${message}`);
    // Send to your GUI's log viewer
  },

  debug: (message: string) => {
    console.debug(`[DEBUG] ${message}`);
    // Send to your GUI's log viewer (optional)
  }
};

// Use with progress and logging
async function convertWithCallbacks() {
  await processEmlxs(
    '/path/to/input',
    '/path/to/output',
    false, // ignoreErrors
    false, // skipDeleted
    progressReporter,
    logger
  );
}

convertWithCallbacks().catch(err => console.error(err));
```

## TypeScript Interfaces

### ProgressReporter

```typescript
interface ProgressReporter {
  /**
   * Called when starting to process files
   * @param total Total number of files to process
   */
  onStart?(total: number): void;

  /**
   * Called for each file being processed
   * @param current Current file number (1-based)
   * @param total Total number of files
   * @param fileName Name of the file being processed
   */
  onProgress?(current: number, total: number, fileName: string): void;

  /**
   * Called when all files are processed
   */
  onComplete?(): void;
}
```

### Logger

```typescript
interface Logger {
  /**
   * Log an informational message
   */
  info?(message: string): void;

  /**
   * Log a warning message
   */
  warn?(message: string): void;

  /**
   * Log an error message
   */
  error?(message: string): void;

  /**
   * Log a debug message
   */
  debug?(message: string): void;
}
```

## IMAP Import with Progress and Logging

```typescript
import { imapImport, ProgressReporter, Logger } from 'partial-emlx-converter';

async function importToImap() {
  await imapImport('/path/to/input', {
    host: 'imap.example.com',
    port: 993,
    user: 'username',
    pass: 'password',
    mailbox: 'INBOX',
    tls: 'yes',
    ignoreErrors: false,
    skipDeleted: false,
    progressReporter: progressReporter, // Your ProgressReporter implementation
    logger: logger                       // Your Logger implementation
  });
}
```

## Example: Electron/GUI Integration

```typescript
import { ipcRenderer } from 'electron';
import { processEmlxs, ProgressReporter, Logger } from 'partial-emlx-converter';

// Send progress updates to the renderer process
const guiProgressReporter: ProgressReporter = {
  onStart: (total) => {
    ipcRenderer.send('conversion-started', total);
  },
  onProgress: (current, total, fileName) => {
    ipcRenderer.send('conversion-progress', {
      current,
      total,
      percentage: Math.round((current / total) * 100),
      fileName
    });
  },
  onComplete: () => {
    ipcRenderer.send('conversion-complete');
  }
};

// Send log messages to the renderer process
const guiLogger: Logger = {
  info: (msg) => ipcRenderer.send('log', { level: 'info', message: msg }),
  warn: (msg) => ipcRenderer.send('log', { level: 'warn', message: msg }),
  error: (msg) => ipcRenderer.send('log', { level: 'error', message: msg }),
  debug: (msg) => ipcRenderer.send('log', { level: 'debug', message: msg })
};

// Use in your conversion function
export async function startConversion(inputDir: string, outputDir: string) {
  try {
    await processEmlxs(
      inputDir,
      outputDir,
      false,
      false,
      guiProgressReporter,
      guiLogger
    );
  } catch (error) {
    ipcRenderer.send('conversion-error', error.message);
  }
}
```

## Backward Compatibility

All new parameters (`progressReporter` and `logger`) are **optional**. Existing code will continue to work without any changes:

```typescript
// This still works exactly as before
await processEmlxs(inputDir, outputDir);
await processEmlxs(inputDir, outputDir, true); // with ignoreErrors
await processEmlxs(inputDir, outputDir, true, true); // with skipDeleted
```

## CLI Usage (Unchanged)

The command-line interface remains unchanged:

```bash
# Convert mode
partial-emlx-converter convert /path/to/input /path/to/output
partial-emlx-converter convert /path/to/input /path/to/output --ignoreErrors
partial-emlx-converter convert /path/to/input /path/to/output --skipDeleted

# IMAP import mode
partial-emlx-converter imapImport /path/to/input \
  -h imap.example.com \
  -u username \
  --pass password \
  -m INBOX
```
