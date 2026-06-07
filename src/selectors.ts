/**
 * Update these selectors after inspecting the live site in DevTools.
 * Prefer stable attributes: id, name, data-testid.
 */
export const selectors = {
  login: {
    url: "/login",
    email: "#email",
    password: "#password",
    captchaImage: "#image",
    captchaInput: 'input[name="captcha"]',
    captchaRefresh: ".fa_icon",
    submit: "button.btn-customlogin",
    registerLink: 'a[href*="/register"]',
    errorMessage: "#password-error, .valid_color, .error",
    sessionConflictModal: "#sessionConflictModalLabel",
    sessionConflictLoginHere:
      'button:has-text("Login Here"), #forceLoginForm button[type="submit"]',
    forceLoginForm: "#forceLoginForm",
  },
  availability: {
    section: "#cardSection",
    district: "#district",
    trek: "#trek",
    date: "#check_in",
    checkButton: "#check_avail",
    slotResults: ".slot_card, .available_text",
  },
  slot: {
    slotCard: (id: string) => `div.col-md-3#timeslot${id}`,
    slotRadio: (mappingId: string) =>
      `input.timeslot-radio[name="timeslot_mapping_id"][value="${mappingId}"]`,
    slotByTime: (time: string) => `.slot_text:has-text("${time}")`,
    bookNow: "#bookTrekButton",
  },
  members: {
    formRow: "#formRow",
    addVisitorButton: "#addVisitorButton",
    name: (index: number) => `input[name="data[${index}][name]"]`,
    idType: (index: number) => `select[name="data[${index}][govt_id_type]"]`,
    idNumber: (index: number) => `input[name="data[${index}][govt_id]"]`,
    age: (index: number) => `input[name="data[${index}][age]"]`,
    gender: (index: number) => `select[name="data[${index}][gender]"]`,
    mobile: (index: number) => `input[name="data[${index}][mobile_no]"]`,
    getOtpButton: "#otp-button",
    resendOtpButton: "#sendOtpButton1",
    otpInput: '#otp-section input#otp-input[type="text"], input#otp-input[type="text"]',
    verifyOtpButton: "#verify-otp-button",
    termsCheckbox: "#defaultCheck1",
    proceedToPayment: "#proceed-button",
  },
  payment: {
    proceedButton:
      '#proceed-button, button:has-text("Pay"), button:has-text("Proceed to Pay"), button:has-text("Make Payment")',
    surepayUrl: "surepay.ndml.in",
    upiOption: 'a[href*="/surepay/upi"], a#padding[href*="upi"]',
    upiPageUrl: "/surepay/upi",
    confirmationUrl: "aranyavihaara.karnataka.gov.in",
    vpaInput: ".upi-form input.mat-mdc-input-element, #mat-input-0",
    payNowButton: 'button:has-text("Pay Now")',
    failureMessage:
      'text=Payment failed, text=Transaction failed, text=declined, text=Failed',
    successMessage:
      'text=Payment successful, text=successfully, text=Success, text=confirmed',
  },
  download: {
    myBookingsNav: 'a:has-text("My Bookings"), text=My Bookings',
    upcomingTreks: 'text=Upcoming Treks, a:has-text("Upcoming")',
    downloadButton:
      'a:has-text("Download"), button:has-text("Download"), text=Download Permit',
  },
} as const;
