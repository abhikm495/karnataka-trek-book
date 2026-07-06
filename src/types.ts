export type TestMode = "preview" | "dry-run" | "fail-pay" | "live";

export type Member = {
  name: string;
  age: number;
  gender: "Male" | "Female" | "Others";
  idType: "Pancard" | "VoterId" | "RationCard" | "DrivingLicense" | "Passport";
  idNumber: string;
  mobile: string;
};

export type BookingConfig = {
  district?: string;
  districtId?: string;
  trek?: string;
  trekId: string;
  date: string;
  timeSlot?: string;
  timeSlotId: string;
  timeSlotMappingId: string;
  members: Member[];
  upiVpa: string;
};

export type AppConfig = {
  email: string;
  password: string;
  testMode: TestMode;
  baseUrl: string;
  authPath: string;
};

export type Step =
  | "login"
  | "availability"
  | "booking"
  | "payment"
  | "download"
  | "all";
