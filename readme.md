📧 .emlx and .partial.emlx to .eml converter
============================================

[![Actions Status](https://github.com/qqilihq/partial-emlx-converter/workflows/CI/badge.svg)](https://github.com/qqilihq/partial-emlx-converter/actions)
[![codecov](https://codecov.io/gh/qqilihq/partial-emlx-converter/branch/master/graph/badge.svg)](https://codecov.io/gh/qqilihq/partial-emlx-converter)
[![npm version](https://badge.fury.io/js/partial-emlx-converter.svg)](https://badge.fury.io/js/partial-emlx-converter)

This script converts `.emlx` and `.partial.emlx` files written by Apple’s [Mail.app](https://en.wikipedia.org/wiki/Mail_(Apple)) into fully self-contained, “stand alone” `.eml` files which can be imported and opened by a great variety of email applications (Mail.app, Thunderbird, …).

Apple uses these formats for internal storage (see `~/Library/Mail/Vx`), and under normal circumstances you will not come in contact with those files. Unfortunately, one of my IMAP mailboxes went out of service and I was not able to copy all the messages to a different account with Mail.app, even though all mails and attachments were there (see [here](https://apple.stackexchange.com/questions/312942/recovering-emails-from-defunct-imap-account) for the story).

That’s why I created this script.

## Installation

### With Homebrew

This is the easiest way if you’re not a Node.js developer. Install the script and all dependencies with [Homebrew](https://brew.sh):

```shell
$ brew install qqilihq/partial-emlx-converter/partial-emlx-converter
```

I would like to make this script available in the Homebrew core repository as well, but for this the project needs more ⭐️ and 🍴 — please help!

### With NPM/Yarn

Use a current version of [Node.js](https://nodejs.org/en/) (currently built and tested with v10.15.3 LTS) and run the following command to install the script globally with [npm](https://www.npmjs.com):

```shell
$ npm install --global partial-emlx-converter
```

## Usage

`partial-emlx-converter` supports to operation modes: `convert` to convert `.emlx` files to `.eml` files, and `imapImport` for importing `.emlx` files directly to an IMAP server.

### `convert` mode

Run the script with at least two arguments: (1) Path to the directory which contains the `.emlx` and `.partial.emlx` files, (2) path to the existing directory where the results should be written to.

```shell
$ partial-emlx-converter convert
Usage: partial-emlx-converter convert [options] <input_directory> <output_directory>

convert .emlx-files from input folder to .eml files in output folder

Arguments:
  input_directory   input folder to read .emlx-files from
  output_directory  output folder for .eml-files

Options:
  --ignoreErrors    Don't abort the conversion on error (see the log output for details in this case)
  --skipDeleted     Skip messages marked as deleted
  -h, --help        display help for command

# sample
$ partial-emlx-converter /path/to/input /path/to/result
```

Optionally, you can specify `--ignoreErrors` as third argument. This way, the conversion will not be aborted in case there’s an error for a file (see the log output for details in this case).
You can also use `--skipDeleted` to skip messages marked as deleted in the emlx flags.

### `imapImport` mode

With the IMAP import, additional context information (IMAP Flags / received timestamps) from the .elmx attached plist object is used.

```shell
$ ./bin/partial-emlx-converter imapImport --help
Usage: partial-emlx-converter imapImport [options] <input_directory>

Import mails from emlx to IMAP server

Arguments:
  input_directory          input folder to read .emlx-files from

Options:
  -p,--port <port_number>  IMAP port (default: 993)
  -u,--user <username>     User for IMAP authentication
  --pass <password>        Password for IMAP authentication (env: IMAP_PASS)
  -h,--host <hostname>     IMAP server hostname
  -m,--mailbox <mailbox>   IMAP mailbox to import mails into (default: "import")
  --tls <mode>             Use `no` to disable TLS (choices: "yes", "no", default: tls enabled)
  --skipDeleted            Skip messages marked as deleted
  --ignoreErrors           Don't abort conversion on error (see the log output for details in this case)
  --help                   display help for command
```

## Build

Use a current version of [Node.js](https://nodejs.org/en/) (currently built and tested with v10.15.3 LTS). Install the dependencies, run the tests, and compile the TypeScript code with [yarn](https://yarnpkg.com/lang/en/) or npm:

```shell
$ yarn
$ yarn test
$ yarn build
```

## Releasing to NPM

Commit all changes and run the following:

```shell
$ npm login
$ npm version <update_type>
$ npm publish
```

… where `<update_type>` is one of `patch`, `minor`, or `major`. This will update the `package.json`, and create a tagged Git commit with the version number.

After releasing a new version, remember to update the Homebrew formula [here](https://github.com/qqilihq/homebrew-partial-emlx-converter).

## About the file formats

**Disclaimer:** I figured out the following by reverse engineering. I cannot give any guarantee about the correctness. If you feel, that something should be corrected, please let me know.

`.emlx` and `.partial.emlx` are similar to `.eml`, with the following peculiarities:

### .emlx

These files start with a line which contains the length of the actual `.eml` payload:

```
2945
Return-Path: <john@example.com>
X-Original-To: john@example.com
…
```

The number `2945` denotes, that the actual `.eml` payload is 2945 characters long, starting from the second line.

At the end, these files contain an XML [property list](https://en.wikipedia.org/wiki/Property_list) epilogue, which holds some Mail.app-specific meta data. Using the given character length at the file’s beginning, this epilogue can be stripped away easily and an `.eml` file can be created.

**Edit:** Later, I found those additional sources, which basically confirm my findings:
* [Patching .emlx files](https://taoofmac.com/space/blog/2008/03/03/2211)
* [emlx.py](https://gist.github.com/karlcow/5276813)
* [emlx flags?](https://www.jwz.org/blog/2005/07/emlx-flags/)
* [Documentation on Apple Mail's .emlx data structure(s) (for conversion purposes)?](https://stackoverflow.com/questions/884440/documentation-on-apple-mails-emlx-data-structures-for-conversion-purposes)

### .partial.emlx

Mail.app uses this format to save emails which contain attachments. Attachments are saved as separate, regular files relative to the `.partial.emlx` file. Afaik, Apple does this due to Spotlight indexing.

Mail.app’s internal file structure looks as follows (nested into two further hierarchies of directories named with number 0 to 9):

```
Attachments/
  1234/
    1.2/
      image001.jpg
    2/
      file.zip
  …
Messages/
  1234.partial.emlx
  …
```

`1234` is obviously the email’s ID. The `Attachments` directory contains the raw attachment files, whereas `Messages` contains the messages stripped of their attachments (and `.emlx` files, for messages which did not contain any attached files in first place).

The subdirectories `1.2` and `2` in above’s example are numbered according to their positions within the corresponding email’s [Multipart](https://www.w3.org/Protocols/rfc1341/7_2_Multipart.html) hierarchy.

To convert a `.partial.emlx` file into an `.eml` file, the separated attachments need to be re-integrated into the file.

## Credits

Without the following modules I would probably be still working on this script (or have given up on the way). Thank you for saving me so much time!

* [mailsplit](https://github.com/andris9/mailsplit)

Beside that, here are some resources which I found very helpful during development:

* [Test Cases for HTTP Content-Disposition header field (RFC 6266) and the Encodings defined in RFCs 2047, 2231 and 5987](http://test.greenbytes.de/tech/tc2231/)
* [The Content-Transfer-Encoding Header Field](https://www.w3.org/Protocols/rfc1341/5_Content-Transfer-Encoding.html)

## Contributing

Pull requests are very welcome and I highly appreciate any [contributions](https://github.com/qqilihq/partial-emlx-converter/graphs/contributors). Feel free to discuss bugs or new features by opening a new issue. In case you submit any bug fixes, please provide corresponding test cases and make sure that existing tests do not break.

- - -

Copyright (c) 2018 – 2025 Philipp Katz
