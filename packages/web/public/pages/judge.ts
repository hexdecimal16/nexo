import type { JudgeCalibrationResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { renderCalibration } from "../lib/judge-view.ts";
import { asErrorBody, el, getJson } from "./api.ts";

const target = el<HTMLElement>("#calibration");
const errorBox = el<HTMLDivElement>("#error");

getJson<JudgeCalibrationResponse>("/api/judge/calibration")
	.then((data) => {
		target.innerHTML = renderCalibration(data).value;
	})
	.catch((error: unknown) => {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	});
