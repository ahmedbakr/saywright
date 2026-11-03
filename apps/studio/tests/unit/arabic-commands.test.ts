import { describe, expect, it } from 'vitest';
import { ARABIC_DEICTIC, arabicAmount, arabicCommand } from '../../shared/arabic-commands';

const cmd = (s: string) => arabicCommand(s)?.text ?? null;

describe('Arabic commands', () => {
  it.each([
    ['تراجع', 'undo'],
    ['رجعها زي ما كانت', null],
    ['ارجع', 'undo'],
    ['احتفظ به', 'keep it'],
    ['تمام كده', 'keep it'],
    ['إلغاء', 'cancel'],
    ['انزل لتحت', 'scroll down'],
    ['اطلع لفوق', 'scroll up'],
    ['شغّل الاختبار', 'run the test'],
    ['اكتب اختبار لهذا', 'generate a test'],
    ['اعمل تيست', 'generate a test'],
    ['صلحه', 'fix it'],
  ])('“%s” → %s', (said, want) => {
    expect(cmd(said)).toBe(want);
  });

  it.each([
    ['اختار الأب', 'select parent'],
    ['اختار اللي جواه', 'select the child'],
    ['ادخل جوه', 'select the child'],
    ['اللي بعده', 'select next'],
    ['التالي', 'select next'],
    ['اللي قبله', 'select previous'],
    ['الغي التحديد', 'deselect'],
    ['وده كمان', 'add this'],
    ['ضيف ده', 'add this'],
    ['اختار الزرار', 'select the button'],
    ['اختار الكارت', 'select the card'],
    ['حدد البطاقة', 'select the card'],
    ['اختار الصورة اللي جواه', 'select the image inside'],
    ['اختار العنوان', 'select the heading'],
  ])('selection: “%s” → %s', (said, want) => {
    expect(cmd(said)).toBe(want);
  });

  it('hears a short command through a misspelling', () => {
    // What recognisers wrote for “تراجع” and “احتفظ به”.
    expect(cmd('تاجع')).toBe('undo');
    expect(cmd('احتفظ بيه')).toBe('keep it');
    expect(cmd('الغا')).toBe('cancel');
  });

  it.each([
    ['كبّر هذا', 'make this bigger'],
    ['كبير هذا', 'make this bigger'],
    ['خليه أكبر', 'make it bigger'],
    ['خلي ده اكبر شوية', 'make this bigger'],
    ['صغّر هذا', 'make this smaller'],
    ['اجعله أحمر', 'make it red'],
    ['غيّر اللون إلى الأخضر', 'make it green'],
    ['خلي الزرار ده أزرق', 'make this blue'],
    ['احذف هذا', 'remove this'],
    ['شيله', 'remove it'],
    ['انقل هذا فوق ذلك', 'move this above that'],
    ['حط ده تحت ده', 'move this below that'],
    ['زود المسافة بين الكروت', 'more space between these'],
    ['اجعل هذا مثل ذلك', 'make this look like that'],
    // As a recogniser writing formal Arabic spells it, and said to a woman.
    ['اجعله احمرا', 'make it red'],
    ['غيري اللون الى الاخضر', 'make it green'],
    ['صغري ده', 'make this smaller'],
    ['احذفي هذا', 'remove this'],
  ])('edit: “%s” → %s', (said, want) => {
    expect(cmd(said)).toBe(want);
  });

  it('turns an expected amount into a check', () => {
    expect(cmd('المفروض يكون ثمانين دولار وثمانين سنت')).toBe('it should show $80.80');
    expect(cmd('المفروض ده يكون ثمانين دولار وثمانين سنت')).toBe('this should show $80.80');
    expect(cmd('يجب أن يكون الإجمالي 80.80 دولار')).toBe('it should show $80.80');
    // Arabic digits with the Arabic decimal separator, as a recogniser writes them.
    expect(cmd('ده لازم يظهر ٨٠٫٨٠ دولار')).toBe('this should show $80.80');
  });

  it('leaves questions and requests it doesn’t know to Claude', () => {
    expect(cmd('ليه الإجمالي غلط')).toBeNull();
    expect(cmd('أضف رسالة خطأ لما الكوبون يكون غلط')).toBeNull();
    expect(cmd('make this bigger')).toBeNull();
    expect(cmd('')).toBeNull();
  });
});

describe('Arabic amounts', () => {
  it.each([
    ['ثمانين دولار وثمانين سنت', 80.8],
    ['خمسة وسبعين', 75],
    ['مية وعشرين جنيه', 120],
    ['تسعة وتسعين دولار', 99],
    ['78.40', 78.4],
    ['٧٨٫٤٠', 78.4],
    ['78,40 دولار', 78.4],
    ['١٬٢٥٠ جنيه', 1250],
  ])('“%s” = %s', (said, value) => {
    expect(arabicAmount(said)?.value).toBeCloseTo(value, 2);
  });
});

describe('Arabic pointing words', () => {
  it.each(['هذا', 'هذه', 'ده', 'دي', 'ذلك', 'هنا', 'وهذا'])('“%s” points', (w) => expect(ARABIC_DEICTIC.test(w)).toBe(true));
  it.each(['زرار', 'الدفع', 'اكبر'])('“%s” does not', (w) => expect(ARABIC_DEICTIC.test(w)).toBe(false));
});
