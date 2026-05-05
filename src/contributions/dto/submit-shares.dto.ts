import { IsNumber, Min } from 'class-validator';

export class SubmitSharesDto {
  @IsNumber()
  @Min(1)
  sharesCount: number;
}
