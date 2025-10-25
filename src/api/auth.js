import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import config from "../config/env.js";

class UpbitAuth {
  generateToken(queryParams = null) {
    const payload = {
      access_key: config.UPBIT_ACCESS_KEY,
      nonce: uuidv4(),
    };

    if (queryParams) {
      const query = new URLSearchParams(queryParams).toString();
      const hash = crypto.createHash("sha512");
      const queryHash = hash.update(query, "utf-8").digest("hex");

      payload.query_hash = queryHash;
      payload.query_hash_alg = "SHA512";
    }

    return jwt.sign(payload, config.UPBIT_SECRET_KEY);
  }

  getAuthHeaders(queryParams = null) {
    const token = this.generateToken(queryParams);
    return {
      Authorization: `Bearer ${token}`,
    };
  }
}

export default new UpbitAuth();
