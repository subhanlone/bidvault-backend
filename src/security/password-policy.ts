import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as english from '@zxcvbn-ts/language-en';

const estimator = new ZxcvbnFactory({
  dictionary: { ...common.dictionary, ...english.dictionary },
  graphs: common.adjacencyGraphs,
  translations: english.translations,
});

/** Reject passwords in zxcvbn's two weakest/commonest bands (scores 0 and 1). */
export function isAcceptablePassword(password: string): boolean {
  return estimator.check(password).score >= 2;
}
