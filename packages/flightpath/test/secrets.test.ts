import { describe, expect, it } from "vitest";

import { scrubSecrets } from "../src/redact/secrets.js";

describe("scrubSecrets", () => {
  it.each([
    [
      "aws access key",
      "key is AKIAIOSFODNN7EXAMPLE ok",
      "[redacted:aws-access-key]",
    ],
    ["aws session key", "ASIA1234567890ABCDEF", "[redacted:aws-access-key]"],
    [
      "github token",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "[redacted:github-token]",
    ],
    [
      "github fine-grained token",
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
      "[redacted:github-token]",
    ],
    [
      "anthropic key",
      "sk-ant-api03-abcdefghij1234567890",
      "[redacted:anthropic-key]",
    ],
    [
      "openai key",
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "[redacted:openai-key]",
    ],
    ["slack token", "xoxb-123456789012-abcdefghijkl", "[redacted:slack-token]"],
    [
      "google api key",
      "AIzaSyA12345678901234567890123456789012",
      "[redacted:google-api-key]",
    ],
    [
      "jwt",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3",
      "[redacted:jwt]",
    ],
  ])("redacts a %s", (_name, input, marker) => {
    const out = scrubSecrets(`before ${input} after`);
    expect(out).toContain(marker);
    expect(out).not.toContain(input);
    expect(out.startsWith("before ")).toBe(true);
    expect(out.endsWith(" after")).toBe(true);
  });

  it("redacts a private key block across lines", () => {
    const block =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nabcdef\n-----END RSA PRIVATE KEY-----";
    expect(scrubSecrets(`x ${block} y`)).toBe("x [redacted:private-key] y");
  });

  it("redacts only the password in a URL", () => {
    expect(scrubSecrets("clone https://user:hunter2@example.com/r.git")).toBe(
      "clone https://user:[redacted:url-password]@example.com/r.git",
    );
  });

  it("redacts an Authorization header value in one piece", () => {
    expect(scrubSecrets("Authorization: Bearer abcdefghijklmnop")).toBe(
      "Authorization: [redacted:authorization]",
    );
    expect(scrubSecrets("authorization: token-abc123")).toBe(
      "authorization: [redacted:authorization]",
    );
  });

  it("redacts a standalone bearer token", () => {
    expect(scrubSecrets("send Bearer abcdefghij.klmnop now")).toBe(
      "send Bearer [redacted:bearer] now",
    );
  });

  it("redacts password and token flag values", () => {
    expect(scrubSecrets("cmd --password hunter2 --verbose")).toBe(
      "cmd --password [redacted:flag-value] --verbose",
    );
    expect(scrubSecrets("cmd --token=abc123def456")).toBe(
      "cmd --token=[redacted:flag-value]",
    );
    expect(scrubSecrets("mysql -h db -psecret")).toBe(
      "mysql -h db -p[redacted:flag-value]",
    );
    expect(scrubSecrets("mysql -p secret")).toBe(
      "mysql -p [redacted:flag-value]",
    );
  });

  it("leaves a numeric -p value (a port) alone", () => {
    expect(scrubSecrets("psql -p 5432 -h db")).toBe("psql -p 5432 -h db");
    expect(scrubSecrets("mysql -p 5432")).toBe("mysql -p 5432");
  });

  it.each([
    ["mkdir -p", "mkdir -p src/units"],
    ["cp -p", "cp -pr a b"],
    ["tar -p flags", "tar -pczf out.tgz ."],
  ])("leaves ordinary %s commands alone", (_name, input) => {
    expect(scrubSecrets(input)).toBe(input);
  });

  it("redacts -p values for the whole MySQL family", () => {
    expect(scrubSecrets("mariadb -p secret")).toBe(
      "mariadb -p [redacted:flag-value]",
    );
    expect(scrubSecrets("mysqldump -psecret mydb")).toBe(
      "mysqldump -p[redacted:flag-value] mydb",
    );
    expect(scrubSecrets("mysqladmin -psecret status")).toBe(
      "mysqladmin -p[redacted:flag-value] status",
    );
  });

  it("redacts bare PASSWORD and TOKEN assignments", () => {
    expect(scrubSecrets("PASSWORD=hunter2 ./run")).toBe(
      "PASSWORD=[redacted:env-secret] ./run",
    );
    expect(scrubSecrets("export PASSWORD=hunter2")).toBe(
      "export PASSWORD=[redacted:env-secret]",
    );
    expect(scrubSecrets("TOKEN=abc123 ./run")).toBe(
      "TOKEN=[redacted:env-secret] ./run",
    );
  });

  it("redacts secret-looking assignments", () => {
    expect(scrubSecrets("API_KEY=abc123def456")).toBe(
      "API_KEY=[redacted:env-secret]",
    );
    expect(scrubSecrets('export SESSION_TOKEN="xyz-987"')).toBe(
      "export SESSION_TOKEN=[redacted:env-secret]",
    );
    expect(scrubSecrets("db_password: hunter2")).toBe(
      "db_password: [redacted:env-secret]",
    );
  });

  it.each([
    [
      "git sha",
      "commit a1e969a2613afbd82717b0e7b909c5cc36c7cb54c3866f3f3edd4885e065c74f",
    ],
    ["uuid", "id 550e8400-e29b-41d4-a716-446655440000"],
    ["base64 hash", "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="],
    [
      "ordinary prose",
      "the password field is required; tokens are counted, keys are pressed",
    ],
  ])("leaves %s alone", (_name, input) => {
    expect(scrubSecrets(input)).toBe(input);
  });
});
