import type { ApiSession } from "./http.js";

const SUREPAY_BASE = "https://surepay.ndml.in/SurePayPayment";

type ChargesResponse = {
  transactionDetails?: Array<{
    amtPayableInPaise?: number;
    totalAmountPayable?: number;
    merchantOrderId?: string;
  }>;
};

type TxnStatusResponse = {
  errorCode?: number;
  txnStatus?: string;
  orderId?: string;
  timeStamp?: string;
};

type PayResponse = {
  action?: string;
  url?: string;
  requestMethod?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractSurepayOrderId(paymentUrl: string): string {
  const url = new URL(paymentUrl);
  const token = url.searchParams.get("token");
  if (!token) {
    throw new Error("SurePay URL is missing token parameter.");
  }
  return decodeURIComponent(token);
}

function upiReferer(orderId: string): string {
  const encoded = encodeURIComponent(orderId);
  return `https://surepay.ndml.in/surepay-webapp-v2/surepay/upi?token=${encoded}`;
}

function surepayHeaders(referer: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: "https://surepay.ndml.in",
    Referer: referer,
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON (${response.status}): ${text.slice(0, 200)}`);
  }
}

async function getChargesDetails(
  session: ApiSession,
  orderId: string,
  referer: string,
): Promise<ChargesResponse> {
  const response = await session.fetch(
    `${SUREPAY_BASE}/sp/rest/getChargesDetailsOnEntity`,
    {
      method: "POST",
      headers: surepayHeaders(referer),
      body: JSON.stringify({
        surePayOrderId: orderId,
        channelCode: "UPI",
        entityCode: "UPI",
      }),
    },
  );

  if (response.status !== 200) {
    throw new Error(`getChargesDetailsOnEntity failed (${response.status})`);
  }

  return parseJson<ChargesResponse>(response);
}

async function verifyUpi(
  session: ApiSession,
  orderId: string,
  vpa: string,
  referer: string,
): Promise<void> {
  const response = await session.fetch(`${SUREPAY_BASE}/aggregator/verifyUpi`, {
    method: "POST",
    headers: surepayHeaders(referer),
    body: JSON.stringify({
      surePayOrderId: orderId,
      channelCode: "UPI",
      aggrCode: "RPAY",
      entityCode: vpa,
    }),
  });

  const result = await parseJson<{ Message?: string }>(response);
  if (response.status !== 200 || result.Message !== "Success") {
    throw new Error(`UPI verification failed: ${result.Message ?? response.status}`);
  }
}

async function createRazorpayOrder(
  session: ApiSession,
  orderId: string,
  vpa: string,
  amountPaise: number,
  referer: string,
): Promise<void> {
  const body = new URLSearchParams({
    surepayOrderId: orderId,
    amount: String(amountPaise),
    channelCode: "UPI",
    entityCode: "UPI",
    vpa_id: vpa,
    cgst: "0",
    sgst: "0",
    aggrCode: "RPAY",
    serviceCharge: "0",
  });

  const response = await session.fetch(`${SUREPAY_BASE}/createRazorpayOrder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json",
      Origin: "https://surepay.ndml.in",
      Referer: referer,
    },
    body: body.toString(),
  });

  if (response.status !== 200) {
    throw new Error(`createRazorpayOrder failed (${response.status})`);
  }
}

async function initiateUpiCollect(
  session: ApiSession,
  orderId: string,
  referer: string,
): Promise<PayResponse> {
  const response = await session.fetch(`${SUREPAY_BASE}/aggregator/pay`, {
    method: "POST",
    headers: surepayHeaders(referer),
    body: JSON.stringify({
      surePayOrderId: orderId,
      channelCode: "UPI",
      aggrCode: "RPAY",
    }),
  });

  if (response.status !== 200) {
    throw new Error(`aggregator/pay failed (${response.status})`);
  }

  return parseJson<PayResponse>(response);
}

async function checkTxnStatus(
  session: ApiSession,
  orderId: string,
  referer: string,
): Promise<TxnStatusResponse> {
  const response = await session.fetch(
    `${SUREPAY_BASE}/sp/rest/checkTxnStatusOnOrderId`,
    {
      method: "POST",
      headers: surepayHeaders(referer),
      body: JSON.stringify({
        surePayOrderId: orderId,
        channelCode: "UPI",
        entityCode: "UPI",
      }),
    },
  );

  return parseJson<TxnStatusResponse>(response);
}

const SUCCESS_STATUSES = new Set([
  "SUCCESS",
  "PAYMENT_SUCCESS",
  "TXN_SUCCESS",
  "COMPLETED",
]);

const FAILURE_STATUSES = new Set([
  "FAILED",
  "FAILURE",
  "TXN_FAILED",
  "PAYMENT_FAILED",
  "DECLINED",
  "CANCELLED",
]);

async function pollPaymentStatus(
  session: ApiSession,
  orderId: string,
  referer: string,
  timeoutMs = 300_000,
): Promise<TxnStatusResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const status = await checkTxnStatus(session, orderId, referer);
    const txnStatus = status.txnStatus ?? "UNKNOWN";

    if (txnStatus !== lastStatus) {
      console.log(`→ Payment status: ${txnStatus}`);
      lastStatus = txnStatus;
    }

    if (SUCCESS_STATUSES.has(txnStatus)) {
      return status;
    }

    if (FAILURE_STATUSES.has(txnStatus)) {
      throw new Error(`Payment failed with status: ${txnStatus}`);
    }

    await sleep(5_000);
  }

  throw new Error("Payment timed out waiting for UPI approval on phone.");
}

export async function payViaUpiApi(
  session: ApiSession,
  paymentUrl: string,
  vpa: string,
): Promise<TxnStatusResponse> {
  const orderId = extractSurepayOrderId(paymentUrl);
  const referer = upiReferer(orderId);

  console.log("→ Loading UPI payment session...");
  const charges = await getChargesDetails(session, orderId, referer);
  const amountPaise = charges.transactionDetails?.[0]?.amtPayableInPaise;

  if (!amountPaise) {
    throw new Error("Could not read payable amount from SurePay.");
  }

  const amount = charges.transactionDetails?.[0]?.totalAmountPayable ?? amountPaise / 100;
  console.log(`→ Amount: ₹${amount} (${amountPaise} paise)`);

  console.log(`→ Verifying UPI ID: ${vpa}`);
  await verifyUpi(session, orderId, vpa, referer);
  console.log("✓ UPI ID verified");

  console.log("→ Creating Razorpay order...");
  await createRazorpayOrder(session, orderId, vpa, amountPaise, referer);

  console.log("→ Sending UPI collect request (Pay Now)...");
  const payResult = await initiateUpiCollect(session, orderId, referer);
  if (payResult.action === "poll" && payResult.url) {
    console.log("✓ UPI request sent — approve the payment on your phone.");
  } else {
    console.log("✓ UPI collect initiated");
  }

  console.log("→ Waiting for payment confirmation (up to 5 min)...\n");
  const finalStatus = await pollPaymentStatus(session, orderId, referer);
  console.log(`✓ Payment confirmed: ${finalStatus.txnStatus}`);
  return finalStatus;
}
