#!/bin/bash

cd /opt/device_ca/ca

# this makes sure the CA is clean
rm index.txt
touch index.txt
echo "1000" > serial

openssl genrsa -out private/client.key 2048

openssl genrsa -out private/server.key 2048

openssl req -config openssl.cnf -key private/client.key -new -sha256 -out newcerts/client.csr -batch -subj "/C=PT/ST=Lisbon/L= /O=uLinux/OU= /CN=device"

openssl ca -config openssl.cnf -extensions usr_cert -days 375 -notext -md sha256 -in newcerts/client.csr -out certs/client.crt -batch

openssl req -config openssl.cnf -key private/server.key -new -sha256 -out newcerts/server.csr -batch -subj "/C=PT/ST=Lisbon/L= /O=uLinux/OU= /CN=localhost"

openssl ca -config openssl.cnf -extensions server_cert -days 375 -notext -md sha256 -in newcerts/server.csr -out certs/server.crt -batch

cp private/server.key /opt/ulinux-device-daemon/
cp private/client.key /opt/ulinux-device-daemon/
cp certs/server.crt /opt/ulinux-device-daemon/
cp certs/client.crt /opt/ulinux-device-daemon/
