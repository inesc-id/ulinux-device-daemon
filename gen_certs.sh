#!/bin/bash

cd /opt/device_ca/ca

openssl genrsa -out private/client.key.pem 2048

openssl genrsa -out private/server.key.pem 2048

openssl req -config openssl.cnf -key private/client.key -new -sha256 -out newcerts/client.csr -batch -subj "/C=PT/ST=Lisbon/L= /O=uLinux/OU= /CN=localhost"

openssl ca -config openssl.cnf -extensions usr_cert -days 375 -notext -md sha256 -in newcerts/client.csr -out certs/client.crt -batch

openssl req -config openssl.cnf -key private/server.key -new -sha256 -out newcerts/server.csr -batch -subj "/C=PT/ST=Lisbon/L= /O=uLinux/OU= /CN=localhost"

openssl ca -config openssl.cnf -extensions server_cert -days 375 -notext -md sha256 -in newcerts/server.csr -out certs/server.crt

cp private/{server,client}.key /opt/ulinux-device-daemon/
cp certs/{server,client}.crt /opt/ulinux-device-daemon/
