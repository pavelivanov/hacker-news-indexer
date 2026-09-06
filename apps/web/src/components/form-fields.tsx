import { useId } from "react";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldSet,
  FieldLegend,
  FieldGroup,
} from "./ui/field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Checkbox } from "./ui/checkbox";
import { label as humanize } from "../lib/draft";

export function TextField({
  label,
  value = "",
  onChange,
  maxLength,
  multiline = false,
  description,
  required = false,
  disabled = false,
}: {
  label: string;
  value?: string;
  onChange: (value: string) => void;
  maxLength: number;
  multiline?: boolean;
  description?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const props = {
    id,
    name: label,
    value,
    maxLength,
    disabled,
    "aria-required": required,
    autoComplete: "off",
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => onChange(event.target.value),
  };
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? " *" : ""}
      </FieldLabel>
      {multiline ? <Textarea {...props} rows={4} /> : <Input {...props} />}
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

export function Choice<T extends string>({
  label,
  value,
  values,
  onChange,
  placeholder,
  optionLabel = humanize,
  disabled = false,
}: {
  label: string;
  value?: T;
  values: readonly T[];
  onChange: (value: T) => void;
  placeholder?: string;
  optionLabel?: (value: T) => string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        disabled={disabled}
        id={id}
        name={label}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {placeholder ? (
          <NativeSelectOption value="">{placeholder}</NativeSelectOption>
        ) : null}
        {values.map((entry) => (
          <NativeSelectOption key={entry} value={entry}>
            {optionLabel(entry)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  );
}

export function CheckSet<T extends string>({
  title,
  values,
  selected,
  onChange,
}: {
  title: string;
  values: readonly T[];
  selected: readonly T[];
  onChange: (value: T[]) => void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">{title}</FieldLegend>
      <FieldGroup className="gap-3">
        {values.map((value) => (
          <CheckField
            key={value}
            label={humanize(value)}
            checked={selected.includes(value)}
            onChange={(checked) =>
              onChange(
                checked
                  ? [...selected, value]
                  : selected.filter((entry) => entry !== value),
              )
            }
          />
        ))}
      </FieldGroup>
    </FieldSet>
  );
}
