# Encrypted Test Data

Test files in this directory are encrypted because they contain personal data.

## Encrypting data

1. Run the following to prevent error “gpg Inappropriate ioctl for device” (see [here](https://stackoverflow.com/a/57591830))

   ```shell
   $ GPG_TTY=$(tty); export GPG_TTY
   ```

2. Create a directory for each test case and encrypt it as follows:

   ```shell
   $ gpgtar --symmetric --output 234567.gpg 234567
   ```

## Decrypting data

To decrypt all test data (i.e. all `*.gpg` files), simply run the following script with the proper secret:

```shell
$ ./decrypt.sh secrect
```
