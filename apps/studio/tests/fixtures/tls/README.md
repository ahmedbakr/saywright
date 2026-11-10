# A certificate for the tests

`localhost-cert.pem` and `localhost-key.pem` are a self-signed certificate for `localhost`, `127.0.0.1` and `::1`, made
for the tests of apps served over https on this computer. The key protects nothing: it is published here on purpose,
and it isn't part of the package.

To make them again:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
  -keyout localhost-key.pem -out localhost-cert.pem
```
