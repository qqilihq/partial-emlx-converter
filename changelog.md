# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.2] – 2020-12-30

### Fixed
* Filename in `bin` section in `package.json`
* Buffer offsets when fixing boundary strings

## [3.0.1] – 2020-12-30

### Changed
* Use dedicated `bin` directory for CLI

## [3.0.0] – 2020-12-30

### Fixed
* Ensure compatibility with various encodings (see [#17](https://github.com/qqilihq/partial-emlx-converter/issues/17))

### Changed
* Replaced individual libs (`content-disposition`, `content-type`, `eml-format]`, `libqp`, `rfc2047`) with [`mailsplit`](https://github.com/andris9/mailsplit) and completely rewrite conversion logic


## [2.0.1] – 2019-05-16
## [2.0.0] – 2019-05-05
## [1.3.1] – 2019-03-30
## [1.3.0] – 2019-03-24
## [1.2.0] – 2019-03-24
## [1.1.0] – 2019-03-24
