module.exports = {
    PORT: 3001,
    USE_HTTPS: process.env.USE_HTTPS,
    HTTPS_KEY: process.env.HTTPS_KEY || './key.pem',
    HTTPS_CERT: process.env.HTTPS_CERT || './cert.pem',
    HTTPS_CA: process.env.HTTPS_CA,
    DATABASE_URL:  process.env.DATABASE_URL || "postgresql://rubani-clone_owner:npg_i6hMgHxem2sP@ep-dark-king-a5viux15-pooler.us-east-2.aws.neon.tech/rubani-clone?sslmode=require",
    ENC_KEY: process.env.ENC_KEY || 'devkey',
    PRODUCTION: process.env.NODE_ENV  === 'production',
    //Do not set any of this on production

    CRASH_AT: process.env.CRASH_AT || 3  //TODO: Change after consultation Force the crash point
};
